import type { MapNode, Site } from "@fleet-manager/core";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of a site's nodes (y-up meters). */
export function boundsOf(site: Pick<Site, "nodes">): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of site.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Map meters (y-up) to SVG coords (y-down), origin at bounds min. */
export function toSvg(x: number, y: number, bounds: Bounds): { x: number; y: number } {
  return { x: x - bounds.minX, y: bounds.maxY - y };
}

/** viewBox string with padding, for `<svg viewBox>`. */
export function viewBoxFor(bounds: Bounds, pad = 1): string {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  return `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`;
}

/** Index nodes by id for link resolution. */
export function indexNodes(nodes: MapNode[]): Map<string, MapNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}
