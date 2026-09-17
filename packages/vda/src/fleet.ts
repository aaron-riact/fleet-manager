import { ActionStatus, BlockingType, MasterController } from "vda-5050-lib";
import type { AgvId, Headerless, InstantActions, Order } from "vda-5050-lib";
import { OFF_GRAPH_PREFIX } from "@fleet-manager/core";
import type { FleetLocks, LockSnapshot, PathLocker } from "@fleet-manager/core";

export interface FleetWaypoint {
  nodeId: string;
  x: number;
  y: number;
}

/** Where a robot leaves the graph at the end of a tour. */
export interface ParkingTarget {
  id: string;
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

/**
 * Release more of an order (pure): prune traversed nodes, release granted
 * ones, release covered edges. The update must extend the AGV's active base,
 * so nodes at or below baseSeq are dropped except the base itself.
 */
export function stitchRelease(
  order: Headerless<Order>,
  releasedSeqs: number[],
  orderUpdateId: number,
  baseSeq: number,
): Headerless<Order> {
  const next = JSON.parse(JSON.stringify(order)) as Headerless<Order> & {
    nodes: Array<{ sequenceId: number; released: boolean; actions: unknown[] }>;
    edges: Array<{ sequenceId: number; released: boolean }>;
  };
  next.orderUpdateId = orderUpdateId;
  next.nodes = next.nodes.filter((n) => n.sequenceId >= baseSeq);
  if (next.nodes.length === 0) throw new Error("stitch pruned the whole order");
  next.nodes[0]!.released = true;
  next.nodes[0]!.actions = [];
  for (const node of next.nodes) {
    if (releasedSeqs.includes(node.sequenceId)) node.released = true;
  }
  const firstSeq = next.nodes[0]!.sequenceId;
  next.edges = next.edges.filter((e) => e.sequenceId >= firstSeq);
  const maxReleased = Math.max(...next.nodes.filter((n) => n.released).map((n) => n.sequenceId));
  for (const edge of next.edges) {
    if (edge.sequenceId < maxReleased) edge.released = true;
  }
  return next;
}

export interface ActiveOrder {
  orderId: string;
  serial: string;
  nodes: Array<{ nodeId: string; released: boolean }>;
  updateId: number;
}

export interface FleetEvents {
  onLocks?: (snapshot: LockSnapshot) => void;
  onOrders?: (orders: ActiveOrder[]) => void;
  onArrived?: (serial: string, nodeId: string, index: number) => void;
  /** Retained history after each lifecycle end (history views). */
  onHistory?: (history: OrderHistory[]) => void;
}

export type OrderOutcome = "completed" | "cancelled" | "failed";

/** One retained order, written once when it leaves the active set. */
export interface OrderHistory {
  orderId: string;
  serial: string;
  /** Robot-reported traversal, in order. */
  route: Array<{ nodeId: string; index: number }>;
  finishedAt: number;
  outcome: OrderOutcome;
  /** Outcome detail: rejection message or the dispatch error. */
  reason?: string;
}

export interface FleetHistoryOptions {
  /** Keep at most this many records per site (default 500, oldest dropped). */
  maxEntries?: number;
  /** Absolute unix ms cutoff; entries older than it are dropped. */
  maxAgeMs?: number;
}

const DEFAULT_MAX_ENTRIES = 500;

let dispatchCounter = 1;

/** Below this distance the first waypoint is directly reachable (adapter tolerance is 0.5m). */
const APPROACH_THRESHOLD_M = 0.4;

/**
 * Fleet dispatch with traffic locks: the AGV only ever sees the
 * locked horizon. Stitch updates release further nodes as locks allow.
 */
export class Fleet {
  private readonly activeOrders = new Map<string, ActiveOrder>();
  private readonly pathLockers = new Map<string, PathLocker>();
  private readonly cancelled = new Set<string>();
  private readonly history: OrderHistory[] = [];
  private readonly maxEntries: number;
  private readonly maxAgeMs: number | undefined;

  constructor(
    private readonly master: MasterController,
    private readonly locks: FleetLocks,
    private readonly events: FleetEvents = {},
    history: FleetHistoryOptions = {},
  ) {
    this.maxEntries = history.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxAgeMs = history.maxAgeMs;
  }

  private emit(): void {
    try {
      this.events.onLocks?.(this.locks.snapshot());
    } catch {
      /* listener errors must not break dispatch */
    }
  }

  private emitOrders(): void {
    try {
      this.events.onOrders?.([...this.activeOrders.values()]);
    } catch {
      /* listener errors must not break dispatch */
    }
  }

  private emitHistory(): void {
    try {
      this.events.onHistory?.(this.orderHistory());
    } catch {
      /* listener errors must not break dispatch */
    }
  }

  /** Orders in flight right now (stream baselines, status views). */
  activeOrderList(): ActiveOrder[] {
    return [...this.activeOrders.values()];
  }

  /** Retained history: finished orders, newest first. */
  orderHistory(): OrderHistory[] {
    const cutoff =
      this.maxAgeMs === undefined
        ? undefined
        : Date.now() - this.maxAgeMs;
    if (cutoff !== undefined) {
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i]!.finishedAt < cutoff) this.history.splice(i, 1);
      }
    }
    return [...this.history].reverse();
  }

  /**
   * Retain one finished order. Called exactly once per lifecycle end,
   * with the error already classified into an outcome.
   */
  private record(
    orderId: string,
    serial: string,
    route: Array<{ nodeId: string; index: number }>,
    outcome: OrderOutcome,
    reason?: string,
  ): void {
    this.history.push({
      orderId,
      serial,
      route,
      finishedAt: Date.now(),
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
    while (this.history.length > this.maxEntries) this.history.shift();
    this.emitHistory();
  }

  /** True while the robot has an order in flight. */
  isBusy(serialNumber: string): boolean {
    return this.activeOrders.has(serialNumber);
  }

  async dispatch(
    agvId: AgvId,
    waypoints: FleetWaypoint[],
    opts: { from?: { x: number; y: number }; park?: ParkingTarget } = {},
  ): Promise<void> {
    if (waypoints.length === 0) throw new Error("dispatch needs at least one waypoint");
    const serial = agvId.serialNumber ?? "unknown";
    const existing = this.activeOrders.get(serial);
    if (existing) {
      throw new Error(`robot ${serial} is busy with order ${existing.orderId} — wait or cancel first`);
    }
    const first = waypoints[0]!;
    // Off-graph starts (parking spots): prepend the current pose as a
    // pseudo-node. It resolves to always-free dummy locks, so the approach
    // leg runs lock-free and the tour engages the graph on arrival.
    const head =
      opts.from && Math.hypot(first.x - opts.from.x, first.y - opts.from.y) > APPROACH_THRESHOLD_M
        ? [{ nodeId: `${OFF_GRAPH_PREFIX}start-${dispatchCounter}`, x: opts.from.x, y: opts.from.y }, ...waypoints]
        : waypoints;
    // Declare the exit in the same order. A tour that ends on the graph has
    // no safe stopping point in bidirectional territory, so the locker must
    // hold the whole run clear to the final node and no follower can enter
    // behind us. The off-graph park leg is one-way, which IS a safe stop, so
    // the locker stops walking there and a follower can trail us instead.
    const last = waypoints[waypoints.length - 1]!;
    const exits =
      opts.park && Math.hypot(opts.park.x - last.x, opts.park.y - last.y) > APPROACH_THRESHOLD_M;
    const points = exits
      ? [...head, { nodeId: `${OFF_GRAPH_PREFIX}park-${opts.park!.id}`, x: opts.park!.x, y: opts.park!.y }]
      : head;
    return this.lockedDispatch(agvId, points, { exits: Boolean(exits) });
  }

  /**
   * Park off-graph: free-drive to a parking spot, holding no locks.
   * Idle robots wait here instead of sitting on graph nodes.
   */
  async park(
    agvId: AgvId,
    spot: { id: string; x: number; y: number },
    opts: { from?: { x: number; y: number } } = {},
  ): Promise<void> {
    const points =
      opts.from && Math.hypot(spot.x - opts.from.x, spot.y - opts.from.y) > APPROACH_THRESHOLD_M
        ? [
            { nodeId: `${OFF_GRAPH_PREFIX}start-${dispatchCounter}`, x: opts.from.x, y: opts.from.y },
            { nodeId: `park-${spot.id}`, x: spot.x, y: spot.y },
          ]
        : [{ nodeId: `park-${spot.id}`, x: spot.x, y: spot.y }];
    await this.directOrder(agvId, points);
    this.locks.lockerFor(agvId.serialNumber ?? "unknown").clearAllLocks();
  }

  /** All-released multi-point order, no locking — approach legs and parking. */
  private directOrder(agvId: AgvId, points: FleetWaypoint[]): Promise<void> {
    const order = {
      orderId: `fleet-direct-${dispatchCounter++}`,
      orderUpdateId: 0,
      nodes: points.map((w, i) => ({
        nodeId: w.nodeId,
        sequenceId: i * 2,
        released: true,
        nodePosition: { mapId: "local", x: w.x, y: w.y, theta: 0 },
        actions: [],
      })),
      edges: points.slice(1).map((w, i) => ({
        edgeId: `fleet-direct-e${i}`,
        sequenceId: i * 2 + 1,
        startNodeId: points[i]!.nodeId,
        endNodeId: w.nodeId,
        released: true,
        actions: [],
      })),
    } as unknown as Headerless<Order>;
    return new Promise<void>((resolve, reject) => {
      this.master
        .assignOrder(agvId, order, {
          onOrderProcessed: (error: unknown, _cancelled: boolean, active: boolean) => {
            if (active) return;
            if (error) reject(error);
            else resolve();
          },
        } as never)
        .catch(reject);
    });
  }

  private lockedDispatch(
    agvId: AgvId,
    waypoints: FleetWaypoint[],
    opts: { exits?: boolean } = {},
  ): Promise<void> {
    const serial = agvId.serialNumber ?? "unknown";
    const orderId = `fleet-order-${dispatchCounter++}`;
    const { order } = buildIncrementalOrder(orderId, waypoints);
    const nodeIds = waypoints.map((w) => w.nodeId);
    const locker = this.locks.lockerFor(serial);
    // Robot-reported traversal; indexed by sequenceId, not node id (loop
    // tours revisit nodes). History-grade: also used to build the route.
    const traversed: Array<{ nodeId: string; index: number }> = [];
    // An order ends once. The lib can both invoke onOrderProcessed and
    // reject the assign promise for the same order, so without this the
    // same tour is recorded twice — and a mid-tour release failure was
    // recorded not at all.
    let finished = false;
    const finish = (outcome: OrderOutcome, reason?: string) => {
      if (finished) return;
      finished = true;
      this.record(orderId, serial, traversed, outcome, reason);
    };
    const failureReason = (error: unknown) =>
      error instanceof Error ? error.message : String(error);

    const track = (releasedSeqs: Set<number>, updateId: number) => {
      this.activeOrders.set(serial, {
        orderId,
        serial,
        nodes: nodeIds.map((nodeId, i) => ({ nodeId, released: releasedSeqs.has(i * 2) })),
        updateId,
      });
      this.emitOrders();
    };

    return new Promise<void>((resolve, reject) => {
      let orderUpdateId = 0;
      const released = new Set<number>([0]);
      let baseSeq = 0;

      // Register before assigning: the AGV may traverse its start node
      // before the initial assign resolves (it starts there).
      track(released, orderUpdateId);

      const releaseAllowed = (indexes: number[]) => {
        const seqs = indexes.map((i) => i * 2);
        if (seqs.every((s) => released.has(s))) return;
        for (const s of seqs) released.add(s);
        const update = stitchRelease(order, [...released], ++orderUpdateId, baseSeq);
        track(released, orderUpdateId);
        this.master.assignOrder(agvId, update, callbacks as never).catch((error: unknown) => {
          // A release that fails ends the tour like any other failure;
          // rejecting without recording lost it from the history.
          this.activeOrders.delete(serial);
          finish("failed", failureReason(error));
          this.emitOrders();
          reject(error);
        });
      };

      const callbacks = {
        onNodeTraversed: (node: { nodeId: string; sequenceId?: number }) => {
          // Position by sequenceId, NOT indexOf: loop tours revisit nodes,
          // and the first occurrence would rewind the lock window.
          const index =
            typeof node.sequenceId === "number"
              ? node.sequenceId / 2
              : nodeIds.indexOf(node.nodeId);
          if (index >= 0 && index < nodeIds.length) {
            baseSeq = Math.max(baseSeq, index * 2);
            granting.arrivedAt(index);
            traversed.push({ nodeId: node.nodeId, index });
            this.events.onArrived?.(serial, node.nodeId, index);
            this.emit();
          }
        },
        onOrderProcessed: (error: unknown, _cancelled: boolean, active: boolean) => {
          if (active) return;
          this.pathLockers.delete(serial);
          if (this.cancelled.has(serial)) {
            this.cancelled.delete(serial);
            this.activeOrders.delete(serial);
            finish("cancelled");
            this.emitOrders();
            this.emit();
            reject(new Error(`order cancelled for robot "${serial}"`));
            return;
          }
          // Ended off-graph: we hold nothing on the map. Otherwise keep the
          // node we sit on, so nobody routes through us while we idle.
          if (opts.exits) locker.clearAllLocks();
          else granting.clearAllExceptLastPathLocks();
          this.emit();
          this.activeOrders.delete(serial);
          if (error) finish("failed", failureReason(error));
          else finish("completed");
          this.emitOrders();
          if (error) reject(error);
          else resolve();
        },
      };

      const granting = locker.makePathLocker(nodeIds, (nextNodes) => {
        releaseAllowed(nextNodes.map((n) => n.index));
        this.emit();
      });
      this.pathLockers.set(serial, granting);

      this.master
        .assignOrder(agvId, order, callbacks as never)
        .then(() => {
          granting.arrivedAt(0);
          this.events.onArrived?.(serial, nodeIds[0]!, 0);
          this.emit();
        })
        .catch((error: unknown) => {
          try {
            granting.clearAllPathLocks();
          } catch {
            /* already clean */
          }
          this.pathLockers.delete(serial);
          this.activeOrders.delete(serial);
          finish(this.cancelled.has(serial) ? "cancelled" : "failed", failureReason(error));
          this.emitOrders();
          reject(error);
        });
    });
  }

  /**
   * Cancel the active order via the VDA cancelOrder action. The AGV
   * stops, all path locks release, and the in-flight dispatch rejects.
   * Throws when the robot has no active order.
   */
  async cancel(agvId: AgvId): Promise<void> {
    const serial = agvId.serialNumber ?? "unknown";
    const granting = this.pathLockers.get(serial);
    if (!granting || !this.activeOrders.has(serial)) {
      throw new Error(`no active order for robot "${serial}"`);
    }
    this.cancelled.add(serial);
    try {
      await new Promise<void>((resolve, reject) => {
        this.master
          .initiateInstantActions(
            agvId,
            {
              actions: [
                {
                  actionId: this.master.createUuid(),
                  actionDescription: "Cancel running order",
                  actionType: "cancelOrder",
                  blockingType: BlockingType.Hard,
                },
              ],
            } as unknown as Headerless<InstantActions>,
            {
              onActionStateChanged: (actionState) => {
                if (actionState.actionStatus === ActionStatus.Finished) resolve();
              },
              onActionError: (error) => reject(error),
            },
          )
          .catch(reject);
      });
    } catch (error) {
      this.cancelled.delete(serial);
      throw error;
    }
    granting.clearAllPathLocks();
  }
}
