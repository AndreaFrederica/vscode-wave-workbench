// SPDX-License-Identifier: MPL-2.0

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Branch<T> {
  bounds: Bounds;
  items?: readonly T[];
  left?: Branch<T>;
  right?: Branch<T>;
}

function intersects(a: Bounds, b: Bounds) {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  );
}

// Keep wide segments in a single leaf. A grid would duplicate them in every
// cell they cross, which is common for feedback edges and fan-out.
export function spatialIndex<T extends { bounds: Bounds }>(items: T[]) {
  function build(items: T[]): Branch<T> {
    const bounds: Bounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    for (const { bounds: box } of items) {
      bounds.minX = Math.min(bounds.minX, box.minX);
      bounds.minY = Math.min(bounds.minY, box.minY);
      bounds.maxX = Math.max(bounds.maxX, box.maxX);
      bounds.maxY = Math.max(bounds.maxY, box.maxY);
    }
    if (items.length <= 24) return { bounds, items };
    const horizontal = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
    items.sort(({ bounds: a }, { bounds: b }) =>
      horizontal
        ? a.minX + a.maxX - b.minX - b.maxX
        : a.minY + a.maxY - b.minY - b.maxY,
    );
    const mid = items.length >> 1;
    return {
      bounds,
      left: build(items.slice(0, mid)),
      right: build(items.slice(mid)),
    };
  }

  const root = items.length ? build(items) : undefined;
  return (bounds: Bounds, visit: (item: T) => void) => {
    function query(branch: Branch<T>) {
      if (!intersects(bounds, branch.bounds)) return;
      if (branch.items) {
        for (const item of branch.items)
          if (intersects(bounds, item.bounds)) visit(item);
      } else {
        query(branch.left!);
        query(branch.right!);
      }
    }
    if (root) query(root);
  };
}
