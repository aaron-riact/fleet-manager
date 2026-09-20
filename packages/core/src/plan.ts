import type { Site } from "./site.js";

/**
 * Shortest node path over the site graph (Dijkstra, Euclidean weights,
 * directed links plus the reverse of bidirectional ones). Pure.
 *
 * Returns node ids from start to goal inclusive, or undefined when the
 * goal is unreachable (or either id is unknown). A zero-length trip
 * (start === goal) returns [start].
 */
export function shortestPath(site: Site, from: string, to: string): string[] | undefined {
  const nodes = new Map(site.nodes.map((n) => [n.id, n]));
  if (!nodes.has(from) || !nodes.has(to)) return undefined;
  if (from === to) return [from];

  const edges = new Map<string, Array<{ to: string; cost: number }>>();
  const link = (a: string, b: string) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    const list = edges.get(a) ?? [];
    list.push({ to: b, cost: Math.hypot(na.x - nb.x, na.y - nb.y) });
    edges.set(a, list);
  };
  for (const l of site.links) {
    if (!nodes.has(l.source) || !nodes.has(l.destination)) continue;
    link(l.source, l.destination);
    if (l.bidirectional) link(l.destination, l.source);
  }

  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let current: string | undefined;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!done.has(id) && d < best) {
        current = id;
        best = d;
      }
    }
    if (current === undefined) return undefined;
    if (current === to) break;
    done.add(current);
    for (const { to: next, cost } of edges.get(current) ?? []) {
      if (done.has(next)) continue;
      const alt = best + cost;
      if (alt < (dist.get(next) ?? Infinity)) {
        dist.set(next, alt);
        prev.set(next, current);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
  return path;
}

/**
 * Locked route for driving a finished robot to parking over the
 * network instead of free-driving it: from its nearest node to the
 * spot's entry (or nearest node). The caller appends the parking leg
 * itself via the dispatch `park` option. Returns undefined when either
 * end has no node or no path connects them — then the caller falls
 * back to free-drive park rather than stranding the robot. Pure.
 */
export function parkRoute(
  site: Site,
  from: { x: number; y: number },
  spot: { id: string; x: number; y: number; entry?: string },
): Array<{ nodeId: string; x: number; y: number }> | undefined {
  const nodes = new Map(site.nodes.map((n) => [n.id, n]));
  const endId =
    (spot.entry && nodes.has(spot.entry) ? spot.entry : undefined) ??
    nearestNode(site, spot.x, spot.y);
  const startId = nearestNode(site, from.x, from.y);
  if (!endId || !startId) return undefined;
  const path = shortestPath(site, startId, endId);
  if (!path) return undefined;
  return path.map((id) => {
    const node = nodes.get(id)!;
    return { nodeId: node.id, x: node.x, y: node.y };
  });
}

/**
 * Nearest graph node to a free coordinate (station poses address work,
 * not graph nodes). Ties break to the earlier node — deterministic.
 * Pure, tested.
 */
export function nearestNode(site: Site, x: number, y: number): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of site.nodes) {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bestD) {
      best = n.id;
      bestD = d;
    }
  }
  return best;
}
