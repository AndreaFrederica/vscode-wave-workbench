// SPDX-License-Identifier: MPL-2.0

import type { mergeStaticContinuationGraph } from "./rtl-static-continuations";
import type { mergeTemporalContinuationGraph } from "./rtl-trace";

export function staticGraphSnapshot(
  graph: ReturnType<typeof mergeStaticContinuationGraph>,
) {
  const {
    signals,
    assignments,
    gaps,
    feedbackEdges,
    bitSelection,
    ...metadata
  } = graph;
  return {
    kind: "static" as const,
    metadata: {
      ...metadata,
      bitSelection: bitSelection && {
        bit: bitSelection.bit,
        range: bitSelection.range,
      },
    },
    sections: { signals, assignments, gaps, feedbackEdges },
  };
}

export function temporalGraphSnapshot(
  graph: ReturnType<typeof mergeTemporalContinuationGraph>,
) {
  const { nodes, edges, gaps, assignmentSources, ...metadata } = graph;
  return {
    kind: "temporal" as const,
    metadata: {
      ...metadata,
      sourceSegmentCount: assignmentSources.length,
      missingSourceSegments: assignmentSources.flatMap((sources, segment) =>
        sources === null ? [segment] : [],
      ),
    },
    sections: {
      nodes,
      edges,
      gaps,
      assignmentSources: assignmentSources.flatMap((sources, segment) =>
        Object.entries(sources ?? {}).map(([assignment, source]) => ({
          segment,
          assignment: Number(assignment),
          source,
        })),
      ),
    },
  };
}

export function traceGraphPage(
  section: readonly unknown[],
  offset: number,
  limit: number,
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > section.length ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 128
  )
    throw Error("Invalid graph page bounds.");

  const items: unknown[] = [];
  let bytes = 2;
  const maximumBytes = 2 * 1024 * 1024;
  for (
    let index = offset;
    index < Math.min(offset + limit, section.length);
    index++
  ) {
    const item = section[index];
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (items.length && bytes + itemBytes > maximumBytes) break;
    items.push(item);
    bytes += itemBytes;
  }
  const end = offset + items.length;
  return {
    offset,
    total: section.length,
    items,
    nextOffset: end < section.length ? end : undefined,
  };
}
