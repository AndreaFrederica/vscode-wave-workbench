// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use serde::Serialize;
use std::{collections::HashMap, sync::Arc};
use wavebench_reader::vcd::{window, Events};
#[derive(Clone, Hash, PartialEq, Eq)]
pub struct Key {
    pub signal: String,
    pub start: u64,
    pub end: u64,
    pub limit: usize,
    pub ordered: bool,
}
pub struct Block {
    pub events: Events,
    pub truncated: bool,
}
struct Entry {
    block: Arc<Block>,
    bytes: usize,
    used: u64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub hits: u64,
    pub misses: u64,
    pub containing_hits: u64,
    pub evictions: u64,
    pub bytes: usize,
    pub entries: usize,
    pub budget: usize,
    pub reads: u64,
}
pub struct Cache {
    entries: HashMap<Key, Entry>,
    pub stats: Stats,
    clock: u64,
}
impl Cache {
    pub fn new(budget: usize) -> Self {
        Self {
            entries: HashMap::new(),
            stats: Stats {
                budget,
                ..Stats::default()
            },
            clock: 0,
        }
    }
    pub fn get(&mut self, key: &Key) -> Option<Arc<Block>> {
        self.get_with_window(key, window)
    }
    pub fn get_linear(&mut self, key: &Key) -> Option<Arc<Block>> {
        self.get_with_window(key, crate::derived::linear_window)
    }
    fn get_with_window(
        &mut self,
        key: &Key,
        clip: fn(&[(u64, String)], u64, u64, usize) -> (Events, bool),
    ) -> Option<Arc<Block>> {
        self.clock += 1;
        if let Some(entry) = self.entries.get_mut(key) {
            entry.used = self.clock;
            self.stats.hits += 1;
            return Some(entry.block.clone());
        }
        // A truncated block cannot answer a different query: its missing tail is unknown.
        let containing = self
            .entries
            .iter()
            .filter(|(k, v)| {
                !key.ordered
                    && !k.ordered
                    && k.signal == key.signal
                    && k.start <= key.start
                    && k.end >= key.end
                    && !v.block.truncated
            })
            .min_by_key(|(k, _)| k.end - k.start)
            .map(|(k, _)| k.clone());
        if let Some(k) = containing {
            let entry = self.entries.get_mut(&k).unwrap();
            entry.used = self.clock;
            self.stats.hits += 1;
            self.stats.containing_hits += 1;
            let (events, truncated) = clip(&entry.block.events, key.start, key.end, key.limit);
            return Some(Arc::new(Block { events, truncated }));
        }
        self.stats.misses += 1;
        None
    }
    pub fn insert(&mut self, key: Key, block: Arc<Block>) {
        let bytes = std::mem::size_of::<Entry>()
            + std::mem::size_of::<Key>()
            + std::mem::size_of::<Block>()
            + 64
            + key.signal.capacity()
            + block.events.capacity() * std::mem::size_of::<(u64, String)>()
            + block
                .events
                .iter()
                .map(|(_, v)| v.capacity())
                .sum::<usize>();
        // Oversized results are returned to the caller but never retained in the cache.
        if bytes > self.stats.budget {
            return;
        }
        if let Some(old) = self.entries.remove(&key) {
            self.stats.bytes -= old.bytes;
        }
        while !self.entries.is_empty()
            && (self.stats.bytes + bytes > self.stats.budget || self.entries.len() >= 4096)
        {
            self.evict();
        }
        self.clock += 1;
        self.entries.insert(
            key,
            Entry {
                block,
                bytes,
                used: self.clock,
            },
        );
        self.stats.bytes += bytes;
        self.stats.entries = self.entries.len();
    }
    fn evict(&mut self) {
        if let Some(key) = self
            .entries
            .iter()
            .min_by_key(|(_, v)| v.used)
            .map(|(k, _)| k.clone())
        {
            let entry = self.entries.remove(&key).unwrap();
            self.stats.bytes -= entry.bytes;
            self.stats.evictions += 1;
            self.stats.entries = self.entries.len();
        }
    }
    pub fn configure(&mut self, budget: usize) {
        self.stats.budget = budget;
        while !self.entries.is_empty() && self.stats.bytes > budget {
            self.evict();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn key(id: &str, start: u64, end: u64, limit: usize) -> Key {
        Key {
            signal: id.into(),
            start,
            end,
            limit,
            ordered: false,
        }
    }
    fn block(truncated: bool) -> Arc<Block> {
        Arc::new(Block {
            events: vec![(0, "0".into()), (10, "1".into()), (20, "0".into())],
            truncated,
        })
    }
    #[test]
    fn exact_containing_and_truncation() {
        let mut c = Cache::new(8192);
        c.insert(key("a", 0, 30, 10), block(false));
        assert!(c.get(&key("a", 0, 30, 10)).is_some());
        let found = c.get(&key("a", 12, 25, 10)).unwrap();
        assert_eq!(found.events, vec![(10, "1".into()), (20, "0".into())]);
        assert!(!found.truncated);
        assert!(c.get(&key("a", 0, 30, 1)).unwrap().truncated);
        c.insert(key("b", 0, 30, 1), block(true));
        assert!(c.get(&key("b", 12, 25, 10)).is_none());
        assert_eq!(c.stats.containing_hits, 2);
    }
    #[test]
    fn ordered_reads_use_exact_ordered_entries() {
        let mut cache = Cache::new(8192);
        let normal = key("a", 0, 30, 10);
        let ordered = Key {
            ordered: true,
            ..normal.clone()
        };
        cache.insert(normal.clone(), block(false));
        assert!(cache.get(&ordered).is_none());
        cache.insert(ordered.clone(), block(false));
        assert!(cache.get(&ordered).is_some());
        assert!(cache
            .get(&Key {
                start: 10,
                ..ordered
            })
            .is_none());
        assert!(cache.get(&normal).is_some());
    }
    #[test]
    fn bounded_lru_disabled_and_oversized() {
        let mut c = Cache::new(8192);
        c.insert(key("a", 0, 30, 10), block(false));
        let size = c.stats.bytes;
        c.configure(size * 2);
        c.insert(key("b", 0, 30, 10), block(false));
        c.get(&key("a", 0, 30, 10));
        c.insert(key("c", 0, 30, 10), block(false));
        assert!(!c.entries.contains_key(&key("b", 0, 30, 10)));
        assert!(c.stats.bytes <= c.stats.budget);
        assert_eq!(c.stats.evictions, 1);
        c.configure(0);
        assert_eq!(c.stats.entries, 0);
        c.insert(key("a", 0, 30, 10), block(false));
        assert_eq!(c.stats.bytes, 0);
    }
}
