import { MasterController } from "vda-5050-lib";
import type { AgvId, Headerless, Order } from "vda-5050-lib";
import type { FleetLocks, LockSnapshot } from "@fleet-manager/core";

export interface FleetWaypoint {
  nodeId: string;
  x: number;
  y: number;
}

interface BuiltOrder {
  order: Headerless<Order>;
  sequenceOf: Map<string, number>;
}

/** Build an incremental order: only the first node released. */
export function buildIncrementalOrder(orderId: string, waypoints: FleetWaypoint[]): BuiltOrder {
  if (waypoints.length === 0) throw new Error("dispatch needs at least one waypoint");
  const sequenceOf = new Map<string, number>();
  const nodes = waypoints.map((w, i) => {
    const sequenceId = i * 2;
    sequenceOf.set(w.nodeId, sequenceId);
    return {
      nodeId: w.nodeId,
      sequenceId,
      released: i === 0,
      nodePosition: { mapId: "local", x: w.x, y: w.y, theta: 0 },
      actions: [],
    };
  });
  const edges = waypoints.slice(1).map((w, i) => ({
    edgeId: `fleet-e${i}`,
    sequenceId: i * 2 + 1,
    startNodeId: waypoints[i]!.nodeId,
    endNodeId: w.nodeId,
    released: false,
    actions: [],
  }));
  return {
    order: { orderId, orderUpdateId: 0, nodes, edges } as unknown as Headerless<Order>,
    sequenceOf,
  };
}

/** Release more of an order (pure): nodes in releasedSeqs + edges below the max. */
export function stitchRelease(
  order: Headerless<Order>,
  releasedSeqs: number[],
  orderUpdateId: number,
): Headerless<Order> {
  const next = JSON.parse(JSON.stringify(order)) as Headerless<Order> & {
    nodes: Array<{ sequenceId: number; released: boolean }>;
    edges: Array<{ sequenceId: number; released: boolean }>;
  };
  next.orderUpdateId = orderUpdateId;
  for (const node of next.nodes) {
    if (releasedSeqs.includes(node.sequenceId)) node.released = true;
  }
  const maxReleased = Math.max(...next.nodes.filter((n) => n.released).map((n) => n.sequenceId));
  for (const edge of next.edges) {
    if (edge.sequenceId < maxReleased) edge.released = true;
  }
  return next;
}

let dispatchCounter = 1;

/**
 * Fleet dispatch with traffic locks: the AGV only ever sees the
 * locked horizon. Stitch updates release further nodes as locks allow.
 */
export class Fleet {
  constructor(
    private readonly master: MasterController,
    private readonly locks: FleetLocks,
    private readonly onLocks?: (snapshot: LockSnapshot) => void,
  ) {}

  private emit(): void {
    try {
      this.onLocks?.(this.locks.snapshot());
    } catch {
      /* listener errors must not break dispatch */
    }
  }

  async dispatch(agvId: AgvId, waypoints: FleetWaypoint[]): Promise<void> {
    const serial = agvId.serialNumber ?? "unknown";
    const { order } = buildIncrementalOrder(`fleet-order-${dispatchCounter++}`, waypoints);
    const nodeIds = waypoints.map((w) => w.nodeId);
    const locker = this.locks.lockerFor(serial);

    return new Promise<void>((resolve, reject) => {
      let orderUpdateId = 0;
      const released = new Set<number>([0]);

      const releaseAllowed = (indexes: number[]) => {
        const seqs = indexes.map((i) => i * 2);
        if (seqs.every((s) => released.has(s))) return;
        for (const s of seqs) released.add(s);
        const update = stitchRelease(order, [...released], ++orderUpdateId);
        this.master.assignOrder(agvId, update, callbacks as never).catch(reject);
      };

      const callbacks = {
        onNodeTraversed: (node: { nodeId: string }) => {
          const index = nodeIds.indexOf(node.nodeId);
          if (index >= 0) {
            granting.arrivedAt(index);
            this.emit();
          }
        },
        onOrderProcessed: (error: unknown, _cancelled: boolean, active: boolean) => {
          if (active) return;
          granting.clearAllPathLocks();
          this.emit();
          if (error) reject(error);
          else resolve();
        },
      };

      const granting = locker.makePathLocker(nodeIds, (nextNodes) => {
        releaseAllowed(nextNodes.map((n) => n.index));
        this.emit();
      });

      this.master
        .assignOrder(agvId, order, callbacks as never)
        .then(() => {
          granting.arrivedAt(0);
          this.emit();
        })
        .catch((error: unknown) => {
          try {
            granting.clearAllPathLocks();
          } catch {
            /* already clean */
          }
          reject(error);
        });
    });
  }
}
