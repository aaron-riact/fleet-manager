import type { MapLink, MapNode } from "@fleet-manager/core";
import type { DispatchWaypoint } from "./backend.js";

export interface Point {
  x: number;
  y: number;
}

/** Nearest graph node to a free position (station poses live off-graph). */
export function nearestNode(nodes: MapNode[], at: Point): MapNode | undefined {
  let best: MapNode | undefined;
  let bestDist = Infinity;
  for (const node of nodes) {
    const d = (node.x - at.x) ** 2 + (node.y - at.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }
  return best;
}

/** BFS node-id path over links (either direction counts when bidirectional). */
export function findPath(links: MapLink[], fromId: string, toId: string): string[] | undefined {
  if (fromId === toId) return [fromId];
  const edges = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = edges.get(a) ?? [];
    list.push(b);
    edges.set(a, list);
  };
  for (const link of links) {
    add(link.source, link.destination);
    if (link.bidirectional ?? false) add(link.destination, link.source);
  }
  const prev = new Map<string, string | null>([[fromId, null]]);
  const queue = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) {
      const path = [toId];
      let node: string | null = toId;
      while ((node = prev.get(node!) ?? null) !== null) path.unshift(node);
      return path;
    }
    for (const next of edges.get(current) ?? []) {
      if (!prev.has(next)) {
        prev.set(next, current);
        queue.push(next);
      }
    }
  }
  return undefined;
}

/**
 * Station-to-station tour: nearest nodes joined by graph path.
 * Undefined when either end has no node or no path connects them.
 */
export function buildTour(
  nodes: MapNode[],
  links: MapLink[],
  pickup: Point,
  drop: Point,
): DispatchWaypoint[] | undefined {
  const from = nearestNode(nodes, pickup);
  const to = nearestNode(nodes, drop);
  if (!from || !to) return undefined;
  const ids = findPath(links, from.id, to.id);
  if (!ids) return undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ids.map((id) => {
    const node = byId.get(id)!;
    return { nodeId: node.id, x: node.x, y: node.y };
  });
}
