import { shortestPath } from "./plan.js";
import { findStation, stationNode } from "./stations.js";
import { isFresh } from "./poses.js";
import type { NodeActionAttachment } from "./actions.js";
import type { DemandCounts } from "./demand.js";
import type { Site } from "./site.js";

/**
 * A pickup→dropoff job between two stations. `requested` is demand not
 * yet dispatchable: the dropoff is known but nobody has attached a
 * pickup, so the pump skips it until it becomes `queued`. Only queued
 * tasks ever reach a robot. Stations turn into graph nodes only when the
 * pump builds the tour.
 */
export interface TaskView {
  id: string;
  /** Station id. Absent while requested — attached later via the pickup endpoint. */
  pickup?: string;
  /** Station id. */
  dropoff: string;
  status: "requested" | "queued" | "assigned" | "done" | "failed";
  /** Demand zone this task was requested for, if any (pump weighting). */
  zone?: string;
  /**
   * This request took a unit of its zone's demand, so withdrawing it
   * gives one back. False when the zone was already at zero: the task
   * is still created, but it is holding nothing to return.
   */
  holdsDemand?: boolean;
  assignee?: string;
  /** Fleet order id once dispatched — the key into order history. */
  orderId?: string;
  reason?: string;
  createdAt: number;
}

/** Terminal tasks retained per site (queued/assigned never dropped). */
export const MAX_RETAINED_TASKS = 200;

/**
 * A task-input problem with its HTTP status attached. Shared by the
 * server endpoints and the demo so both reject the same inputs with
 * the same messages — validation lives here once, status mapping
 * stays with each caller (HTTP codes are a transport concern).
 */
export interface RouteIssue {
  status: 400 | 409;
  message: string;
}

/** Single station reference check (always a 400 when wrong). */
export function checkStation(
  site: Pick<Site, "locations">,
  label: string,
  id: unknown,
): RouteIssue | undefined {
  if (typeof id !== "string" || !id) return { status: 400, message: `${label} required` };
  if (!findStation(site, id)) return { status: 400, message: `${label} must be a known station` };
  return undefined;
}

/** Pickup→dropoff station pair check (400s, then 409 when their nodes are unroutable). */
export function checkStationPair(
  site: Site,
  pickup: unknown,
  dropoff: unknown,
): RouteIssue | undefined {
  if (typeof pickup !== "string" || !pickup) return { status: 400, message: "pickup required" };
  if (typeof dropoff !== "string" || !dropoff) return { status: 400, message: "dropoff required" };
  const from = stationNode(site, pickup);
  const to = stationNode(site, dropoff);
  if (from === undefined || to === undefined)
    return { status: 400, message: "pickup and dropoff must be known stations" };
  if (!shortestPath(site, from, to))
    return { status: 409, message: `no route from "${pickup}" to "${dropoff}"` };
  return undefined;
}

let taskCounter = 1;

/** Next task id (`task-N`, per process). */
export function nextTaskId(): string {
  return `task-${taskCounter++}`;
}

/** What the pump needs to know about a robot: maker, fix, freshness. */
export interface TaskPose {
  manufacturer: string;
  x: number;
  y: number;
  seenAt: number;
}

/** One tour stop: a graph position plus optional opaque work attachments. */
export interface PumpWaypoint {
  nodeId: string;
  x: number;
  y: number;
  actions?: NodeActionAttachment[];
}

export interface TaskPump {
  site: Site;
  fleet: {
    isBusy(serial: string): boolean;
    dispatch(
      agv: { manufacturer: string; serialNumber: string },
      waypoints: PumpWaypoint[],
      opts?: { from?: { x: number; y: number } },
    ): Promise<string>;
  };
  poses: Map<string, TaskPose>;
  tasks: Map<string, TaskView>;
  /** Outstanding demand per zone — queued tasks serve highest demand first. */
  demands: DemandCounts;
  poseTtlMs: number;
  /**
   * Domain work for the task's stations, riding the tour ends ("pickup" on
   * the first waypoint, "dropoff" on the last). Asked for by station, not
   * node: two stations can share an entry node. Absent means drive-only
   * tours. The pump never interprets the returned attachments — they ride
   * the order nodes to whichever adapter executes them.
   */
  attachments?: (stationId: string, role: "pickup" | "dropoff") => NodeActionAttachment[];
}

/**
 * Assign queued tasks to the nearest free robot with a fresh pose.
 * Idempotent: safe to run on every order event and every submit.
 * Ordering per run is demand first (highest zone count), then oldest,
 * then id — so backlog pressure beats arrival order deterministically.
 * Terminal tasks (done/failed) accumulate only up to MAX_RETAINED_TASKS —
 * the orders history stream is the durable record.
 */
const pumping = new WeakSet<Map<string, TaskView>>();

export function pumpSiteTasks(pump: TaskPump): void {
  // dispatch() emits onOrders synchronously, which calls this again while
  // the loop below is still walking `tasks` — and the retention sweep
  // deletes from that same map. Let the nested call fall through to the
  // outer one instead, so there is only ever one walker.
  if (pumping.has(pump.tasks)) return;
  pumping.add(pump.tasks);
  try {
    assignQueuedTasks(pump);
  } finally {
    pumping.delete(pump.tasks);
  }
}

function assignQueuedTasks({ site, fleet, poses, tasks, demands, poseTtlMs, attachments }: TaskPump): void {
  const now = Date.now();
  const byId = new Map(site.nodes.map((n) => [n.id, n]));
  const queued = [...tasks.values()]
    .filter((t) => t.status === "queued")
    .sort(
      (a, b) =>
        (demands[b.zone ?? ""] ?? 0) - (demands[a.zone ?? ""] ?? 0) ||
        a.createdAt - b.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  for (const task of queued) {
    // Requested tasks never reach the pump (only queued do), so a
    // missing pickup here means corrupt state, not a slow dispatcher.
    if (task.pickup === undefined) {
      task.status = "failed";
      task.reason = `unknown pickup or dropoff station`;
      continue;
    }
    const pickupStation = task.pickup;
    const pickupNode = stationNode(site, pickupStation);
    const dropNode = stationNode(site, task.dropoff);
    const pickup = pickupNode === undefined ? undefined : byId.get(pickupNode);
    if (!pickup || dropNode === undefined || !byId.has(dropNode)) {
      task.status = "failed";
      task.reason = `unknown pickup or dropoff station`;
      continue;
    }
    // Route before robots: an undispatchable task fails whether or not
    // anyone is free to drive it. (Robot search first would park it in
    // queued forever whenever the fleet happened to be busy.)
    const path = shortestPath(site, pickup.id, dropNode);
    if (!path) {
      task.status = "failed";
      task.reason = `no route from "${task.pickup}" to "${task.dropoff}"`;
      continue;
    }
    let best: { serial: string; manufacturer: string; pose: TaskPose; d: number } | undefined;
    for (const [serial, pose] of poses) {
      if (!isFresh(pose, now, poseTtlMs) || fleet.isBusy(serial)) continue;
      const d = (pose.x - pickup.x) ** 2 + (pose.y - pickup.y) ** 2;
      if (!best || d < best.d) best = { serial, manufacturer: pose.manufacturer, pose, d };
    }
    if (!best) continue;
    task.status = "assigned";
    task.assignee = best.serial;
    const from = { x: best.pose.x, y: best.pose.y };
    // Path nodes come from the same graph just routed on — always known.
    // Work attachments ride the tour ends only; middle nodes stay
    // drive-through. A single-node tour is both ends: pickup runs first.
    const waypoints: PumpWaypoint[] = path.map((id, i) => {
      const n = byId.get(id)!;
      const actions = [
        ...(i === 0 ? (attachments?.(pickupStation, "pickup") ?? []) : []),
        ...(i === path.length - 1 ? (attachments?.(task.dropoff, "dropoff") ?? []) : []),
      ];
      return {
        nodeId: id,
        x: n.x,
        y: n.y,
        ...(actions.length > 0 ? { actions } : {}),
      };
    });
    fleet
      .dispatch({ manufacturer: best.manufacturer, serialNumber: best.serial }, waypoints, { from })
      .then(
        (orderId) => {
          task.status = "done";
          task.orderId = orderId;
        },
        (error: unknown) => {
          task.status = "failed";
          task.reason = error instanceof Error ? error.message : String(error);
        },
      );
  }
  const terminal = [...tasks.values()]
    .filter((t) => t.status === "done" || t.status === "failed")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const stale of terminal.slice(MAX_RETAINED_TASKS)) tasks.delete(stale.id);
}
