import { nearestNode, shortestPath } from "@fleet-manager/core";
import type { MapLink, MapNode, Site } from "@fleet-manager/core";
import type { DispatchWaypoint } from "./backend.js";

export interface Point {
  x: number;
  y: number;
}

export interface TourEndpoint extends Point {
  /** Authored graph attachment; beats geometric nearest. */
  entry?: string;
}

function resolveNodeId(
  site: Pick<Site, "nodes" | "links">,
  end: TourEndpoint,
): string | undefined {
  if (end.entry && site.nodes.some((n) => n.id === end.entry)) return end.entry;
  return nearestNode({ name: "", nodes: site.nodes, links: site.links }, end.x, end.y);
}

/**
 * Station-to-station tour that stays on the network. Endpoints resolve
 * through authored entries first, geometric nearest second; with a
 * robot fix, the tour starts at the robot's nearest node so everything
 * past the short approach hop is locked graph — never a straight
 * free-drive line through walls. Undefined when an end has no node or
 * no path connects the legs. Routing itself lives in core; this only
 * resolves endpoints into it.
 */
export function buildTour(
  nodes: MapNode[],
  links: MapLink[],
  pickup: TourEndpoint,
  drop: TourEndpoint,
  robot?: Point,
): DispatchWaypoint[] | undefined {
  const site = { name: "", nodes, links };
  const pickId = resolveNodeId(site, pickup);
  const dropId = resolveNodeId(site, drop);
  const startId = robot ? nearestNode(site, robot.x, robot.y) : pickId;
  if (!pickId || !dropId || !startId) return undefined;
  const toPickup = shortestPath(site, startId, pickId);
  const toDrop = shortestPath(site, pickId, dropId);
  if (!toPickup || !toDrop) return undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [...toPickup, ...toDrop.slice(1)].map((id) => {
    const node = byId.get(id)!;
    return { nodeId: node.id, x: node.x, y: node.y };
  });
}
