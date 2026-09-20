import { shortestPath } from "./plan.js";
import { isFresh } from "./poses.js";
import type { DemandCounts } from "./demand.js";
import type { Site } from "./site.js";

/**
 * A pickup→dropoff job. `requested` is demand not yet dispatchable: the
 * dropoff is known but nobody has attached a pickup, so the pump skips
 * it until it becomes `queued`. Only queued tasks ever reach a robot.
 */
export interface TaskView {
  id: string;
  /** Absent while requested — attached later via the pickup endpoint. */
  pickup?: string;
  dropoff: string;
  status: "requested" | "queued" | "assigned" | "done" | "failed";
  /** Demand zone this task was requested for, if any (pump weighting). */
  zone?: string;
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

/** Single node reference check (always a 400 when wrong). */
export function checkNode(
  site: Pick<Site, "nodes">,
  label: string,
  id: unknown,
): RouteIssue | undefined {
  if (typeof id !== "string" || !id) return { status: 400, message: `${label} required` };
  if (!site.nodes.some((n) => n.id === id))
    return { status: 400, message: `${label} must be a known node` };
  return undefined;
}

/** Pickup→dropoff pair check for dispatch (400s, then 409 when unroutable). */
export function checkRoutePair(
  site: Site,
  pickup: unknown,
  dropoff: unknown,
): RouteIssue | undefined {
  if (typeof pickup !== "string" || !pickup) return { status: 400, message: "pickup required" };
  if (typeof dropoff !== "string" || !dropoff) return { status: 400, message: "dropoff required" };
  const ids = new Set(site.nodes.map((n) => n.id));
  if (!ids.has(pickup) || !ids.has(dropoff))
    return { status: 400, message: "pickup and dropoff must be known nodes" };
  if (!shortestPath(site, pickup, dropoff))
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

export interface TaskPump {
  site: Site;
  fleet: {
    isBusy(serial: string): boolean;
    dispatch(
      agv: { manufacturer: string; serialNumber: string },
      waypoints: Array<{ nodeId: string; x: number; y: number }>,
      opts?: { from?: { x: number; y: number } },
    ): Promise<string>;
  };
  poses: Map<string, TaskPose>;
  tasks: Map<string, TaskView>;
  /** Outstanding demand per zone — queued tasks serve highest demand first. */
  demands: DemandCounts;
  poseTtlMs: number;
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

function assignQueuedTasks({ site, fleet, poses, tasks, demands, poseTtlMs }: TaskPump): void {
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
      task.reason = `unknown pickup or dropoff node`;
      continue;
    }
    const pickup = byId.get(task.pickup);
    const drop = byId.get(task.dropoff);
    if (!pickup || !drop) {
      task.status = "failed";
      task.reason = `unknown pickup or dropoff node`;
      continue;
    }
    // Route before robots: an undispatchable task fails whether or not
    // anyone is free to drive it. (Robot search first would park it in
    // queued forever whenever the fleet happened to be busy.)
    const path = shortestPath(site, task.pickup, task.dropoff);
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
    const waypoints = path.map((id) => {
      const n = byId.get(id)!;
      return { nodeId: id, x: n.x, y: n.y };
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
