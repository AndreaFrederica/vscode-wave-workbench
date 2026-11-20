// SPDX-License-Identifier: MPL-2.0

// Default Mermaid configuration for flowcharts.
const maxText = 50_000;
const maxEdges = 500;
const labelBudget = Math.floor(maxText / 8);
const groupEnd = "  end";

export function mermaidLabel(text: string) {
  return text.replace(
    /[^A-Za-z0-9 _.$:/-]/g,
    (character) => "#" + character.charCodeAt(0) + ";",
  );
}

function flowLabel(text: string) {
  const escaped = mermaidLabel(text);
  if (escaped.length <= labelBudget) return escaped;
  return escaped.slice(0, labelBudget).replace(/#\d*$/, "") + "...";
}

export function mermaidOutput<K extends string>(field: K, pages: string[]) {
  return {
    [field]: pages[0],
    ...(pages.length > 1 ? { [field + "Pages"]: pages } : {}),
  } as Record<K, string> & Partial<Record<`${K}Pages`, string[]>>;
}

export function mermaidMarkdown(pages: readonly string[]) {
  return pages.map((page) => "```mermaid\n" + page + "\n```").join("\n\n");
}

export function createMermaidFlowchart(classes: Record<string, string> = {}) {
  const header = [
    "flowchart LR",
    ...Object.entries(classes).map(
      ([name, style]) => "  classDef " + name + " " + style,
    ),
  ];
  const headerLength = header.join("\n").length;
  const nodes = new Map<string, { line: string; group?: string }>();
  const groups = new Map<string, string>();
  const rendered = new Set<string>();
  const pages: string[] = [];
  let length = headerLength;
  const pageNodes = new Set<string>();
  const pageGroups = new Map<string, string[]>();
  const standalone: string[] = [];
  const edges: string[] = [];
  const groupCost = (id: string) =>
    groups.get(id)!.length + groupEnd.length + 2;

  function flush() {
    const grouped = [...pageGroups].flatMap(([group, lines]) => [
      groups.get(group)!,
      ...lines,
      groupEnd,
    ]);
    pages.push([...header, ...grouped, ...standalone, ...edges].join("\n"));
    length = headerLength;
    pageNodes.clear();
    pageGroups.clear();
    standalone.length = 0;
    edges.length = 0;
  }

  function append(ids: string[], edge?: string) {
    const endpoints = [...new Set(ids)];
    const additions = new Set<string>();
    let cost = edge ? edge.length + 1 : 0;
    for (const id of endpoints) {
      if (pageNodes.has(id)) continue;
      const { line, group } = nodes.get(id)!;
      cost += line.length + 1;
      if (group && !pageGroups.has(group) && !additions.has(group)) {
        additions.add(group);
        cost += groupCost(group);
      }
    }
    if (length + cost >= maxText || (edge && edges.length >= maxEdges)) flush();

    for (const id of endpoints) {
      if (pageNodes.has(id)) continue;
      pageNodes.add(id);
      rendered.add(id);
      const { line, group } = nodes.get(id)!;
      if (group) {
        let members = pageGroups.get(group);
        if (!members) {
          members = [];
          pageGroups.set(group, members);
          length += groupCost(group);
        }
        members.push(line);
      } else standalone.push(line);
      length += line.length + 1;
    }
    if (edge) {
      edges.push(edge);
      length += edge.length + 1;
    }
  }

  return {
    group(id: string, label: string) {
      groups.set(id, "  subgraph " + id + '["' + flowLabel(label) + '"]');
    },
    node(
      id: string,
      label: string,
      options: { group?: string; style?: string } = {},
    ) {
      const { group, style } = options;
      const line =
        "  " +
        id +
        '["' +
        flowLabel(label) +
        '"]' +
        (style ? "\n  class " + id + " " + style : "");
      nodes.set(id, { line, group });
    },
    edge(source: string, target: string, label = "", dotted = false) {
      const arrow = dotted ? "-.->" : "-->";
      append(
        [source, target],
        "  " +
          source +
          " " +
          arrow +
          (label ? "|" + flowLabel(label) + "|" : "") +
          " " +
          target,
      );
    },
    pages() {
      for (const id of nodes.keys()) if (!rendered.has(id)) append([id]);
      flush();
      return pages;
    },
  };
}
