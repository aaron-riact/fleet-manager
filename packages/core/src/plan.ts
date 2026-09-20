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
