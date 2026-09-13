import { MasterController } from "vda-5050-lib";
import type { AgvId, Order, OrderEventHandler } from "vda-5050-lib";

export interface Waypoint {
  nodeId: string;
  x: number;
  y: number;
}

let orderCounter = 1;

/**
 * Rotate waypoints so the tour starts at the node nearest (x, y) and
 * closes the loop back at it. Orders must start within the AGV's
 * deviation range, so call with the robot's current pose.
 */
export function loopFrom(nodes: Waypoint[], x: number, y: number): Waypoint[] {
  if (nodes.length === 0) throw new Error("loopFrom needs at least one node");
  let best = 0;
  let bestDist = Infinity;
  nodes.forEach((n, i) => {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  const rotated = [...nodes.slice(best), ...nodes.slice(0, best)];
  return [...rotated, rotated[0]!];
}

/**
 * Drive a virtual AGV through waypoints (demo scenarios).
 * Positions are free-navigation coordinates, mapId 'local' must match
 * the adapter's initial position (see bootFleet defaults).
 */
export async function driveThrough(
  master: MasterController,
  agvId: AgvId,
  waypoints: Waypoint[],
): Promise<void> {
  if (waypoints.length === 0) throw new Error("driveThrough needs at least one waypoint");
  const nodes = waypoints.map((w, i) => ({
    nodeId: w.nodeId,
    sequenceId: i * 2,
    released: true,
    nodePosition: { mapId: "local", x: w.x, y: w.y, theta: 0 },
    actions: [],
  }));
  const edges = waypoints.slice(1).map((w, i) => ({
    edgeId: `demo-e${i}`,
    sequenceId: i * 2 + 1,
    startNodeId: waypoints[i]!.nodeId,
    endNodeId: w.nodeId,
    released: true,
    actions: [],
  }));
  const order = {
    orderId: `demo-order-${orderCounter++}`,
    orderUpdateId: 0,
    nodes,
    edges,
  } as unknown as Order;
  return new Promise<void>((resolve, reject) => {
    const handler: Pick<OrderEventHandler, "onOrderProcessed"> = {
      onOrderProcessed: (error) => (error ? reject(error) : resolve()),
    };
    master.assignOrder(agvId, order, handler as OrderEventHandler).catch(reject);
  });
}
