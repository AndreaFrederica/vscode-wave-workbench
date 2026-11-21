// SPDX-License-Identifier: MPL-2.0

export function feedbackInGraph<Edge>(
  outgoing: readonly (readonly { node: number; edge: Edge }[])[],
) {
  const state = new Uint8Array(outgoing.length);
  const feedback: Edge[] = [];
  for (let start = 0; start < outgoing.length; start++) {
    if (state[start]) continue;
    const stack = [{ node: start, index: 0 }];
    state[start] = 1;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = outgoing[frame.node][frame.index++];
      if (!next) {
        state[frame.node] = 2;
        stack.pop();
      } else if (state[next.node] === 1) {
        feedback.push(next.edge);
      } else if (state[next.node] === 0) {
        state[next.node] = 1;
        stack.push({ node: next.node, index: 0 });
      }
    }
  }
  return feedback;
}

export function temporalFeedback(
  nodeCount: number,
  edges: readonly { source: number; target: number }[],
  gaps: readonly {
    status: string;
    source?: number;
    target?: number;
    anchor?: number;
  }[] = [],
) {
  type Feedback =
    | { source: number; target: number; edge: number; gap?: never }
    | { source: number; target: number; gap: number; edge?: never };
  const outgoing: { node: number; edge: Feedback }[][] = Array.from(
    { length: nodeCount },
    () => [],
  );
  edges.forEach(({ source, target }, edge) =>
    outgoing[source].push({ node: target, edge: { source, target, edge } }),
  );
  gaps.forEach(({ status, source, target, anchor }, gap) => {
    if (status !== "joined" || source === undefined) return;
    for (const endpoint of new Set([target, anchor])) {
      if (endpoint === undefined || endpoint === source) continue;
      outgoing[source].push({
        node: endpoint,
        edge: { source, target: endpoint, gap },
      });
    }
  });
  const feedback = feedbackInGraph(outgoing);
  return feedback.length ? feedback : undefined;
}
