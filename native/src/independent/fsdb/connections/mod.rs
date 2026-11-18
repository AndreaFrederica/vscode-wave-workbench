// SPDX-License-Identifier: MPL-2.0

mod archive;
mod expression;
mod graph;

use super::{events::EventReader, Events, FileReader, MAX_BLOCK};
use crate::independent::bytes::invalid;
use expression::Expression;
use graph::{Graph, Program};
use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap, HashSet, VecDeque},
    io,
    sync::Arc,
};

type Vertex = (u32, u32);
type Trace = Arc<Events>;

const EVENT_CACHE_BUDGET: usize = 32 * 1024 * 1024;
const TOP_LEVEL_GRAPH: u64 = 0xffff_ffff_0000_0001;

pub(super) struct Connections {
    inputs: HashMap<u32, Vertex>,
    drivers: HashMap<Vertex, u32>,
    bindings: HashMap<Vertex, Vertex>,
    records: HashMap<u64, Vec<u8>>,
    programs: HashMap<u32, Program>,
    graphs: HashMap<u64, Arc<Graph>>,
    model_map: HashMap<u32, (u32, u32)>,
    pool: Option<Vec<Vec<u8>>>,
    expressions: HashMap<u32, Arc<Expression>>,
    traces: HashMap<Vertex, (Trace, usize)>,
    trace_order: VecDeque<Vertex>,
    trace_bytes: usize,
    initial_time: u64,
}

impl Connections {
    pub(super) fn open(file: &mut FileReader) -> io::Result<Self> {
        let [inputs, outputs] = archive::maps(file)?;
        let mut drivers = HashMap::new();
        for (signal, vertex) in outputs {
            if drivers.insert(vertex, signal).is_some() {
                return Err(invalid(
                    "Multiple physical FSDB drivers for the same vertex",
                ));
            }
        }
        let records = if inputs.is_empty() && drivers.is_empty() {
            HashMap::new()
        } else {
            archive::records(file)?
        };
        let programs = if records.is_empty() {
            HashMap::new()
        } else {
            graph::programs(
                records
                    .get(&2)
                    .ok_or_else(|| invalid("Missing FSDB connection programs"))?,
            )?
        };
        let bindings = graph::bindings(records.get(&6).map(Vec::as_slice).unwrap_or_default())?;
        let model_map = records
            .get(&0)
            .map(|bytes| graph::models(bytes))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            inputs,
            drivers,
            bindings,
            records,
            programs,
            graphs: HashMap::new(),
            model_map,
            pool: None,
            expressions: HashMap::new(),
            traces: HashMap::new(),
            trace_order: VecDeque::new(),
            trace_bytes: 0,
            initial_time: file
                .container
                .windows
                .first()
                .ok_or_else(|| invalid("Missing FSDB time windows"))?
                .anchor,
        })
    }

    fn graph(&mut self, context: u32) -> io::Result<Arc<Graph>> {
        let key = if context == 0 {
            TOP_LEVEL_GRAPH
        } else {
            let &(prototype, source) = self
                .model_map
                .get(&context)
                .ok_or_else(|| invalid("Unknown FSDB connection context"))?;
            if source != 0 {
                return Err(invalid("Unrecognized FSDB connection source context"));
            }
            (u64::from(prototype) << 32) | 1
        };
        if let Some(graph) = self.graphs.get(&key) {
            return Ok(graph.clone());
        }
        let bytes = self
            .records
            .get(&key)
            .ok_or_else(|| invalid("Missing FSDB connection graph"))?;
        let composite_key = (key & !0xffff_ffff) | 3;
        let composites = self
            .records
            .get(&composite_key)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let graph = Arc::new(Graph::parse(bytes, composites, &self.programs)?);
        self.graphs.insert(key, graph.clone());
        Ok(graph)
    }

    fn expression(&mut self, id: u32) -> io::Result<Arc<Expression>> {
        if let Some(expression) = self.expressions.get(&id) {
            return Ok(expression.clone());
        }
        if self.pool.is_none() {
            let raw = self
                .records
                .get(&4)
                .ok_or_else(|| invalid("Missing FSDB connection constant pool"))?;
            self.pool = Some(expression::constants(raw)?);
        }
        let program = &self.programs[&id];
        let expression = Arc::new(Expression::parse(program, self.pool.as_ref().unwrap())?);
        self.expressions.insert(id, expression.clone());
        Ok(expression)
    }

    pub(super) fn events(
        &mut self,
        file: &mut FileReader,
        events: &mut EventReader,
        widths: &HashMap<u32, (usize, bool)>,
        id: u32,
    ) -> io::Result<Trace> {
        let Some(&vertex) = self.inputs.get(&id) else {
            return Ok(Arc::new(Vec::new()));
        };
        let mut sources = PhysicalSources {
            file,
            events,
            widths,
        };
        self.node(&mut sources, vertex, &mut HashSet::new())
    }

    fn node(
        &mut self,
        physical: &mut PhysicalSources<'_>,
        key: Vertex,
        stack: &mut HashSet<Vertex>,
    ) -> io::Result<Trace> {
        if let Some((trace, _)) = self.traces.get(&key) {
            if let Some(index) = self
                .trace_order
                .iter()
                .position(|&candidate| candidate == key)
            {
                self.trace_order.remove(index);
                self.trace_order.push_back(key);
            }
            return Ok(trace.clone());
        }
        if stack.len() >= 256 || !stack.insert(key) {
            return Err(invalid("Cyclic or excessive FSDB connection dependency"));
        }
        let trace = self.load_node(physical, key, stack);
        stack.remove(&key);
        let trace = trace?;
        let cost = trace
            .iter()
            .map(|(_, bits)| 144 + bits.len())
            .sum::<usize>();
        if cost <= EVENT_CACHE_BUDGET {
            while self.trace_bytes + cost > EVENT_CACHE_BUDGET || self.traces.len() >= 4096 {
                let oldest = self.trace_order.pop_front().unwrap();
                if let Some((_, cost)) = self.traces.remove(&oldest) {
                    self.trace_bytes -= cost;
                }
            }
            self.trace_order.push_back(key);
            self.traces.insert(key, (trace.clone(), cost));
            self.trace_bytes += cost;
        }
        Ok(trace)
    }

    fn load_node(
        &mut self,
        physical: &mut PhysicalSources<'_>,
        key: Vertex,
        stack: &mut HashSet<Vertex>,
    ) -> io::Result<Trace> {
        let graph = self.graph(key.0)?;
        let node = key.1 as usize;
        if let Some(&signal) = self.drivers.get(&key) {
            let width = *graph
                .widths
                .get(node)
                .filter(|&&width| width <= 65536)
                .ok_or_else(|| invalid("FSDB driver exceeds vertex or width bounds"))?;
            let trace = physical.read(signal, width)?;
            return Ok(Arc::new(trace));
        }
        if let Some(&driver) = self.bindings.get(&key) {
            if node >= graph.widths.len() + graph.secondary as usize {
                return Err(invalid("FSDB bound vertex lies outside its graph"));
            }
            return self.node(physical, driver, stack);
        }
        let width = *graph
            .widths
            .get(node)
            .filter(|&&width| width <= 65536)
            .ok_or_else(|| invalid("FSDB connection exceeds vertex or width bounds"))?;
        if let Some(edges) = graph.edges.get(&key.1) {
            let expressions = edges
                .iter()
                .map(|edge| self.expression(edge.program))
                .collect::<io::Result<Vec<_>>>()?;
            let mut inputs = Inputs::new();
            for edge in edges {
                for &source in &edge.sources {
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        inputs.indices.entry(source)
                    {
                        let trace = self.node(physical, (key.0, source), stack)?;
                        let source_width = graph
                            .widths
                            .get(source as usize)
                            .copied()
                            .or_else(|| trace.first().map(|(_, value)| value.len()))
                            .ok_or_else(|| invalid("Missing FSDB input width"))?;
                        entry.insert(inputs.traces.len());
                        inputs.push(trace, source_width)?;
                    }
                }
            }
            if edges.len() == 1
                && edges[0].operation >> 30 == 2
                && (width != 1 || inputs.traces.len() != 1 || inputs.widths[0] != 1)
            {
                return Err(invalid("Invalid FSDB scalar built-in widths"));
            }
            let positions = edges
                .iter()
                .map(|edge| {
                    edge.sources
                        .iter()
                        .map(|source| inputs.indices[source])
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let single = edges.len() == 1 && !expressions[0].partial();
            let net = !single && graph.attributes[node] & 1 != 0;
            let two_state = graph.attributes[node] & 2 == 0
                && edges.iter().any(|edge| edge.operation >> 30 == 1)
                || single && edges[0].operation >> 30 == 2 && edges[0].operation & 0x3fff_ffff == 4;
            let trace = inputs.merge(self.initial_time, width, |values| {
                let mut result = vec![if net { b'z' } else { b'x' }; width];
                let mut written = vec![false; width];
                for ((edge, expression), positions) in
                    edges.iter().zip(&expressions).zip(&positions)
                {
                    let arguments = positions
                        .iter()
                        .map(|&i| values[i].as_slice())
                        .collect::<Vec<_>>();
                    for (bit, value) in
                        expression.assign(&arguments, width, edge.operation >> 30 == 0)?
                    {
                        if !net && written[bit] {
                            return Err(invalid("Overlapping FSDB connection assignments"));
                        }
                        let slot = &mut result[width - 1 - bit];
                        *slot = if !net || *slot == b'z' {
                            value
                        } else if value == b'z' || *slot == value {
                            *slot
                        } else {
                            b'x'
                        };
                        written[bit] = true;
                    }
                }
                if two_state {
                    for bit in &mut result {
                        if matches!(*bit, b'x' | b'z') {
                            *bit = b'0';
                        }
                    }
                }
                Ok(result)
            })?;
            return Ok(Arc::new(trace));
        }
        let slices = graph
            .composites
            .get(&key.1)
            .ok_or_else(|| invalid("FSDB vertex has no source or assignment"))?;
        let mut inputs = Inputs::new();
        for slice in slices {
            if let std::collections::hash_map::Entry::Vacant(entry) =
                inputs.indices.entry(slice.source)
            {
                let trace = self.node(physical, (key.0, slice.source), stack)?;
                entry.insert(inputs.traces.len());
                inputs.push(trace, graph.widths[slice.source as usize])?;
            }
        }
        let positions: Vec<_> = slices
            .iter()
            .rev()
            .map(|slice| (inputs.indices[&slice.source], slice.start, slice.width))
            .collect();
        let events = inputs.merge(self.initial_time, width, |values| {
            let mut result = Vec::with_capacity(width);
            for &(index, start, len) in &positions {
                let source = &values[index];
                let end = source.len() - start;
                result.extend_from_slice(&source[end - len..end]);
            }
            Ok(result)
        })?;
        Ok(Arc::new(events))
    }
}

struct PhysicalSources<'a> {
    file: &'a mut FileReader,
    events: &'a mut EventReader,
    widths: &'a HashMap<u32, (usize, bool)>,
}

impl PhysicalSources<'_> {
    fn read(&mut self, signal: u32, expected_width: usize) -> io::Result<Events> {
        let &(width, supported) = self
            .widths
            .get(&signal)
            .ok_or_else(|| invalid("Unknown FSDB connection driver signal"))?;
        if !supported || width != expected_width || !self.events.indexed(signal) {
            return Err(invalid("FSDB connection driver encoding or width mismatch"));
        }
        self.events.events(self.file, signal, width, 0, u64::MAX)
    }
}

struct Inputs {
    indices: HashMap<u32, usize>,
    traces: Vec<Trace>,
    widths: Vec<usize>,
}

impl Inputs {
    fn new() -> Self {
        Self {
            indices: HashMap::new(),
            traces: Vec::new(),
            widths: Vec::new(),
        }
    }

    fn push(&mut self, trace: Trace, width: usize) -> io::Result<()> {
        if trace.first().is_none_or(|(_, value)| value.len() != width) {
            return Err(invalid(
                "FSDB connection input has no events or has the wrong width",
            ));
        }
        self.traces.push(trace);
        self.widths.push(width);
        Ok(())
    }

    fn merge(
        self,
        initial_time: u64,
        width: usize,
        render: impl Fn(&[Vec<u8>]) -> io::Result<Vec<u8>>,
    ) -> io::Result<Events> {
        let mut output = Vec::new();
        let mut values: Vec<_> = self
            .widths
            .into_iter()
            .map(|width| vec![b'x'; width])
            .collect();
        let mut transitions: BinaryHeap<_> = self
            .traces
            .iter()
            .enumerate()
            .map(|(source, trace)| Reverse((trace[0].0, source, 0)))
            .collect();
        if transitions.is_empty() {
            let value = String::from_utf8(render(&values)?)
                .map_err(|_| invalid("Invalid FSDB expression value"))?;
            output.push((initial_time, value));
        }
        while let Some(Reverse((instant, _, _))) = transitions.peek().copied() {
            while transitions
                .peek()
                .is_some_and(|Reverse((time, _, _))| *time == instant)
            {
                let Reverse((_, source, index)) = transitions.pop().unwrap();
                values[source].clear();
                values[source].extend_from_slice(self.traces[source][index].1.as_bytes());
                if let Some((next, _)) = self.traces[source].get(index + 1) {
                    transitions.push(Reverse((*next, source, index + 1)));
                }
            }
            let value = render(&values)?;
            if output
                .last()
                .is_none_or(|(_, previous)| previous.as_bytes() != value)
            {
                if output.len() >= 1_000_000 || (output.len() + 1) * width > MAX_BLOCK {
                    return Err(invalid("FSDB derived events exceed bounds"));
                }
                output.push((
                    instant,
                    String::from_utf8(value)
                        .map_err(|_| invalid("Invalid FSDB expression value"))?,
                ));
            }
        }
        Ok(output)
    }
}
