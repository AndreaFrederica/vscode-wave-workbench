// SPDX-License-Identifier: MPL-2.0

use serde_json::{json, Value};
use std::cmp::Ordering;

#[derive(Clone)]
enum Level {
    Real(f64),
    Digital(String),
}

impl Level {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Real(a), Self::Real(b)) => a.total_cmp(b),
            (Self::Digital(a), Self::Digital(b)) => a.cmp(b),
            _ => unreachable!("one encoding per signal"),
        }
    }

    fn text(&self) -> String {
        match self {
            Self::Real(value) => value.to_string(),
            Self::Digital(bits) => bits.clone(),
        }
    }
}

#[derive(Clone, Copy)]
struct Sample {
    tick: u64,
    value: f64,
    segment: usize,
}

struct SampleBin {
    // Keep both endpoints and the real time of each extremum for the analog path.
    first: Sample,
    min: Sample,
    max: Sample,
    last: Sample,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_overview_preserves_peak_time_and_breaks_at_missing_values() {
        let mut overview = Overview::with_real_samples(0, 19, 2);
        for (tick, value) in [
            (0, 0.5),
            (2, 9.0),
            (2, 7.0),
            (4, 0.0),
            (6, 1.0),
            (7, f64::NAN),
            (11, 2.0),
        ] {
            overview.real(tick, value);
        }
        assert_eq!(
            overview.finish(),
            json!([
                [
                    "0",
                    "9",
                    "0",
                    "7",
                    [["0", 0.5, 0], ["2", 7.0, 0], ["4", 0.0, 0], ["6", 1.0, 0]]
                ],
                ["10", "19", "2", "2", [["11", 2.0, 1], ["19", 2.0, 1]]]
            ])
        );
    }
}

impl SampleBin {
    fn insert(&mut self, sample: Sample) {
        if sample.value < self.min.value {
            self.min = sample;
        }
        if sample.value > self.max.value {
            self.max = sample;
        }
        self.last = sample;
    }

    fn points(self) -> Vec<(String, f64, usize)> {
        let mut points = [self.first, self.min, self.max, self.last];
        points.sort_by_key(|sample| sample.tick);
        let mut previous = None;
        points
            .into_iter()
            .filter_map(|sample| {
                if previous.replace(sample.tick) == Some(sample.tick) {
                    return None;
                }
                Some((sample.tick.to_string(), sample.value, sample.segment))
            })
            .collect()
    }
}

pub struct Overview {
    start: u64,
    end: u64,
    step: u64,
    real: bool,
    cells: Vec<Option<(Level, Level)>>,
    previous: Option<(u64, Level)>,
    sample_bins: Option<Vec<Option<SampleBin>>>,
    segment: usize,
}

impl Overview {
    pub fn new(start: u64, end: u64, bins: usize, real: bool) -> Self {
        let span = end - start;
        let step = u64::try_from((u128::from(span) + 1).div_ceil(bins as u128)).unwrap_or(u64::MAX);
        Self {
            start,
            end,
            step,
            real,
            cells: vec![None; (span / step + 1) as usize],
            previous: None,
            sample_bins: None,
            segment: 0,
        }
    }

    pub fn with_real_samples(start: u64, end: u64, bins: usize) -> Self {
        let mut overview = Self::new(start, end, bins, true);
        overview.sample_bins = Some((0..overview.cells.len()).map(|_| None).collect());
        overview
    }

    fn record_real_sample(&mut self, tick: u64, level: &Level) {
        let Some(bins) = &mut self.sample_bins else {
            return;
        };
        let Level::Real(value) = *level else {
            return;
        };
        let tick = tick.max(self.start);
        if tick > self.end {
            return;
        }
        let sample = Sample {
            tick,
            value,
            segment: self.segment,
        };
        let bin = &mut bins[((tick - self.start) / self.step) as usize];
        match bin {
            Some(bin) => bin.insert(sample),
            None => {
                *bin = Some(SampleBin {
                    first: sample,
                    min: sample,
                    max: sample,
                    last: sample,
                })
            }
        }
    }

    fn extend(&mut self, first: u64, last: u64, level: &Level) {
        let first = first.max(self.start);
        let last = last.min(self.end);
        if first > last {
            return;
        }
        let left = ((first - self.start) / self.step) as usize;
        let right = ((last - self.start) / self.step) as usize;
        for cell in &mut self.cells[left..=right] {
            match cell {
                Some((min, max)) => {
                    if level.cmp(min).is_lt() {
                        *min = level.clone();
                    }
                    if level.cmp(max).is_gt() {
                        *max = level.clone();
                    }
                }
                None => *cell = Some((level.clone(), level.clone())),
            }
        }
    }

    fn sample(&mut self, time: u64, level: Option<Level>) {
        if let Some((previous, value)) = self.previous.take() {
            if time > previous {
                self.extend(previous, time - 1, &value);
                if time > self.start {
                    self.record_real_sample(previous, &value);
                }
            }
        }
        if self.sample_bins.is_some() && level.is_none() {
            self.segment += 1;
        }
        self.previous = level.map(|value| (time, value));
    }

    pub fn real(&mut self, time: u64, value: f64) {
        self.sample(time, value.is_finite().then_some(Level::Real(value)));
    }

    pub fn value(&mut self, time: u64, value: String) {
        if self.real {
            self.real(time, value.parse().unwrap_or(f64::NAN));
        } else {
            self.sample(time, Some(Level::Digital(value)));
        }
    }

    pub fn finish(mut self) -> Value {
        if let Some((previous, value)) = self.previous.take() {
            self.extend(previous, self.end, &value);
            self.record_real_sample(previous, &value);
            if previous < self.end {
                self.record_real_sample(self.end, &value);
            }
        }
        let mut sample_bins = self.sample_bins.map(Vec::into_iter);
        Value::Array(
            self.cells
                .into_iter()
                .enumerate()
                .filter_map(|(i, cell)| {
                    let samples = sample_bins.as_mut().map(|bins| {
                        bins.next()
                            .flatten()
                            .map(SampleBin::points)
                            .unwrap_or_default()
                    });
                    let (min, max) = cell?;
                    let start = self.start + i as u64 * self.step;
                    let end = start.saturating_add(self.step - 1).min(self.end);
                    if let Some(samples) = samples {
                        return Some(json!([
                            start.to_string(),
                            end.to_string(),
                            min.text(),
                            max.text(),
                            samples
                        ]));
                    }
                    Some(json!([
                        start.to_string(),
                        end.to_string(),
                        min.text(),
                        max.text()
                    ]))
                })
                .collect(),
        )
    }
}
