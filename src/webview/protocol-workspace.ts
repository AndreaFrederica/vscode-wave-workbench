// SPDX-License-Identifier: MPL-2.0
import type { DecoderInstance } from "../decoder-runtime/types";
import { getElement as $ } from "./dom";
import { localize } from "../shared/localization";

export interface ProtocolLayout {
  explorer: boolean;
  inspector: boolean;
  explorerCollapsed?: boolean;
  inspectorCollapsed?: boolean;
  tracks: boolean;
  dock?: "left" | "right" | "bottom";
  separate?: boolean;
  allTop?: boolean;
}
export function protocolWorkspace(
  saved: Partial<ProtocolLayout> = {},
  changed: () => void,
) {
  const explorer = $("protocolExplorer"),
    inspector = $("protocolInspector");
  const interfaces = $("protocolInterfaces"),
    details = $("protocolDetails");
  const main = explorer.parentElement!;
  const right = document.createElement("section"),
    bottom = document.createElement("section");
  right.className = bottom.className = "protocolSatellite";
  right.setAttribute("aria-label", localize("协议浏览器"));
  bottom.setAttribute("aria-label", localize("协议浏览器"));
  inspector.prepend(right);
  $("viewer").append(bottom);
  // Satellites keep a disclosure control when their trees are folded.
  function satellite(section: HTMLElement, id: string) {
    const button = document.createElement("button"),
      arrow = document.createElement("span"),
      content = document.createElement("div");
    content.id = id;
    arrow.setAttribute("aria-hidden", "true");
    button.className = "protocolDisclosure";
    button.setAttribute("aria-controls", id);
    button.append(arrow, document.createTextNode(localize("协议浏览器")));
    button.onclick = () =>
      setMode("explorer", layout.explorerCollapsed ? "expanded" : "collapsed");
    section.append(button, content);
    return { button, content };
  }
  const rightTree = satellite(right, "protocolRightTrees"),
    bottomTree = satellite(bottom, "protocolBottomTrees");
  const docks = {
    left: interfaces,
    right: rightTree.content,
    bottom: bottomTree.content,
  };
  const roots = new Map<HTMLElement, DecoderInstance>();
  const dockChoice = $("protocolDock") as HTMLSelectElement,
    separate = $("separateTrees") as HTMLInputElement;
  const switches = new Map<string, () => void>();
  let active: string | undefined;
  const layout: ProtocolLayout = {
    explorer: saved.explorer !== false,
    inspector: saved.inspector !== false,
    tracks: saved.tracks !== false,
    explorerCollapsed: saved.explorerCollapsed === true,
    inspectorCollapsed: saved.inspectorCollapsed === true,
    dock: saved.dock ?? "left",
    separate: saved.separate === true,
    allTop: saved.allTop === true,
  };
  const paneMenus = {
    explorer: $("showProtocolExplorer") as HTMLSelectElement,
    inspector: $("showProtocolInspector") as HTMLSelectElement,
  };
  const trackToggle = $("showProtocolTracks") as HTMLInputElement;
  function disclosure(button: HTMLElement, collapsed: boolean) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.firstElementChild!.textContent = collapsed ? "▸" : "▾";
  }
  function sync() {
    $("protocolPaneChoices").hidden = !switches.size;
    trackToggle.checked = layout.tracks;
    $("decoderTracks").hidden = !switches.size || !layout.tracks;
    for (const pane of ["explorer", "inspector"] as const) {
      paneMenus[pane].value = !layout[pane]
        ? "hidden"
        : (
              pane === "explorer"
                ? layout.explorerCollapsed
                : layout.inspectorCollapsed
            )
          ? "collapsed"
          : "expanded";
    }
    disclosure($("foldProtocolExplorer"), !!layout.explorerCollapsed);
    disclosure(rightTree.button, !!layout.explorerCollapsed);
    disclosure(bottomTree.button, !!layout.explorerCollapsed);
    disclosure($("foldProtocolInspector"), !!layout.inspectorCollapsed);
  }
  function arrange() {
    ($("allTracksTop") as HTMLInputElement).checked = !!layout.allTop;
    dockChoice.value = layout.dock ?? "left";
    separate.checked = !!layout.separate;
    for (const [root, instance] of roots) {
      const dock = docks[instance.treeDock ?? layout.dock] ?? interfaces;
      if (root.parentElement !== dock) dock.append(root);
    }
    sync();
    main.classList.toggle("splitProtocolTrees", !!layout.separate);
    explorer.hidden = !layout.explorer || !interfaces.childElementCount;
    main.classList.toggle("hideProtocol-explorer", explorer.hidden);
    right.hidden = !layout.explorer || !rightTree.content.childElementCount;
    bottom.hidden = !layout.explorer || !bottomTree.content.childElementCount;
    const hasDetails = layout.inspector && switches.size > 0;
    inspector.hidden = !hasDetails && right.hidden;
    main.classList.toggle("hideProtocol-inspector", inspector.hidden);
    interfaces.hidden =
      rightTree.content.hidden =
      bottomTree.content.hidden =
        !!layout.explorerCollapsed;
    details.hidden = !hasDetails || !!layout.inspectorCollapsed;
    inspector.querySelector<HTMLElement>(":scope > header")!.hidden =
      !hasDetails;
    main.classList.toggle(
      "protocolLeftRail",
      !explorer.hidden && !!layout.explorerCollapsed,
    );
    main.classList.toggle(
      "protocolRightRail",
      !inspector.hidden &&
        (!hasDetails || !!layout.inspectorCollapsed) &&
        (right.hidden || !!layout.explorerCollapsed),
    );
  }
  $("allTracksTop").onchange = () => {
    layout.allTop = ($("allTracksTop") as HTMLInputElement).checked;
    arrange();
    changed();
  };
  dockChoice.onchange = () => {
    layout.dock = dockChoice.value as ProtocolLayout["dock"];
    arrange();
    changed();
  };
  separate.onchange = () => {
    layout.separate = separate.checked;
    arrange();
    changed();
  };
  function setMode(pane: "explorer" | "inspector", mode: string) {
    layout[pane] = mode !== "hidden";
    if (pane === "explorer") {
      layout.explorerCollapsed = mode === "collapsed";
      if (mode !== "expanded") catalog(false);
    } else layout.inspectorCollapsed = mode === "collapsed";
    arrange();
    changed();
  }
  for (const pane of ["explorer", "inspector"] as const)
    paneMenus[pane].onchange = () => setMode(pane, paneMenus[pane].value);
  trackToggle.onchange = () => {
    layout.tracks = trackToggle.checked;
    arrange();
    changed();
  };
  $("foldProtocolExplorer").onclick = () =>
    setMode("explorer", layout.explorerCollapsed ? "expanded" : "collapsed");
  $("foldProtocolInspector").onclick = () =>
    setMode("inspector", layout.inspectorCollapsed ? "expanded" : "collapsed");
  $("closeProtocolExplorer").onclick = () => setMode("explorer", "hidden");
  $("closeProtocolInspector").onclick = () => setMode("inspector", "hidden");
  function catalog(show: boolean) {
    main.classList.toggle("protocolCatalogVisible", show);
    $("protocolCatalog").setAttribute("aria-pressed", String(show));
  }
  $("protocolCatalog").onclick = () =>
    catalog(!main.classList.contains("protocolCatalogVisible"));
  function attach(instance: DecoderInstance, redraw: () => void) {
    const id = instance.instanceId!;
    const root = document.createElement("details"),
      summary = document.createElement("summary");
    const title = document.createElement("span"),
      count = document.createElement("output");
    const bus =
      instance.bindings.h2d ??
      instance.bindings.awaddr ??
      Object.values(instance.bindings)[0];
    title.textContent = id;
    if (/^[\da-f]{8}-[\da-f-]{27}$/i.test(id) && bus)
      title.textContent = bus.replace(/\s*\[.*$/, "");
    const protocol = document.createElement("small");
    protocol.textContent = instance.decoderId;
    title.title = [
      id,
      ...Object.entries(instance.bindings).map(
        ([pin, path]) => pin + " = " + path,
      ),
    ].join("\n");
    summary.append(title, count, protocol);
    root.append(summary);
    roots.set(root, instance);
    main.classList.add("hasProtocols");

    function activate() {
      if (active !== id) {
        const previous = active;
        active = id;
        if (previous) switches.get(previous)?.();
      }
      catalog(false);
      root.open = true;
      root.classList.add("active");
      $("protocolDetailInterface").textContent = title.textContent;
    }
    switches.set(id, () => {
      root.classList.toggle("active", active === id);
      redraw();
    });
    summary.onclick = (event) => {
      if (active !== id) {
        event.preventDefault();
        activate();
        redraw();
      }
    };
    if (!active || layout.separate) root.open = true;
    if (!active) activate();
    arrange();
    return {
      root,
      count,
      details,
      active: () => active === id,
      activate,
      revealExplorer() {
        setMode("explorer", "expanded");
        activate();
      },
      empty() {
        details.textContent = localize("选择一笔事务查看字段和握手");
      },
      dispose() {
        switches.delete(id);
        roots.delete(root);
        root.remove();
        if (active === id) {
          active = undefined;
          const next = switches.keys().next().value;
          if (next) {
            active = next;
            const nextRoot = [...roots.keys()][0] as HTMLDetailsElement;
            nextRoot.open = true;
            $("protocolDetailInterface").textContent =
              nextRoot.querySelector("summary span")?.textContent ?? "";
            switches.get(next)?.();
          } else {
            details.replaceChildren();
            $("protocolDetailInterface").textContent = "";
          }
        }
        arrange();
        if (!switches.size) {
          main.classList.remove("hasProtocols");
          catalog(false);
        }
      },
    };
  }
  arrange();
  return {
    attach,
    layout,
    arrange,
    restore(value?: Partial<ProtocolLayout>) {
      if (value) {
        Object.assign(
          layout,
          { explorerCollapsed: false, inspectorCollapsed: false },
          value,
        );
        arrange();
      }
    },
  };
}
