import { Elysia } from "elysia";
import { bootSiteFleet, watchConnections, watchRobots, watchStates } from "@fleet-manager/vda";
import type { ActiveOrder, OrderHistory, RobotConnection, RobotPose, SiteFleet } from "@fleet-manager/vda";
import { freeSpot, occupiedSpots, shortestPath } from "@fleet-manager/core";
import type { LockSnapshot, Site } from "@fleet-manager/core";
import { loadUsersFile } from "./usersFile.js";
import { loadSites } from "./sites.js";
import { Auth } from "./auth.js";
import { MemorySessionStore } from "./sessions.js";
import type { SessionStore } from "./sessions.js";
import { SqliteSessionStore } from "./sqlite.js";
import { RateLimiter } from "./rateLimit.js";
import type { SrpPair } from "@fleet-manager/core";

/**
 * Rate-limit bucket for a request. X-Forwarded-For is set by the client
 * unless a trusted proxy overwrites it, so believing it unconditionally
 * hands every caller an unlimited supply of fresh buckets — which is the
 * whole limit. Off by default; turn it on only behind a proxy that
 * rewrites the header (TRUST_PROXY_HEADER=1).
 */
function clientKey(
  headers: Record<string, string | undefined>,
  peer: string | undefined,
  trustProxyHeader: boolean,
): string {
  if (trustProxyHeader) {
    const forwarded = headers["x-forwarded-for"] ?? headers["x-real-ip"];
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  // No peer address available: one shared bucket, which throttles harder
  // rather than not at all.
  return peer ?? "direct";
}

function limited(limiter: RateLimiter, key: string): void {
  if (!limiter.check(key)) throw Object.assign(new Error("too many requests"), { status: 429 });
}

export interface ServeOptions {
  port?: number;
  usersFile: string;
  sitesDir?: string;
  /** Real broker URL. Absent: in-process memory bus. */
  brokerUrl?: string;
  /** VDA interface name. Defaults to the site name (isolates sites). */
  interfaceName?: string;
  /** Manufacturer for dispatch requests that omit one. */
  defaultManufacturer?: string;
  /** How long a pose still describes where a robot is. Default 30s. */
  poseTtlMs?: number;
  /** SQLite sessions file. Absent: in-memory sessions (tests, ephemeral dev). */
  sessionsFile?: string;
  sessionTtlMs?: number;
  /** Matched SRP pair. Defaults to production parameters; tests inject small groups. */
  srp?: SrpPair;
  /** TLS cert/key files. Absent: plain HTTP. */
  tlsCert?: string;
  tlsKey?: string;
  /** Per-minute per-IP caps for the CPU-heavy SRP endpoints. */
  loginStartPerMin?: number;
  loginFinishPerMin?: number;
  /** Global cap on outstanding challenges (spray protection). */
  maxPendingChallenges?: number;
  /** Trust X-Forwarded-For / X-Real-IP. Only behind a proxy that sets them. */
  trustProxyHeader?: boolean;
}

function bearerFromHeaders(headers: Record<string, string | undefined>): string {
  const header = headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw Object.assign(new Error("missing Bearer token"), { status: 401 });
  }
  return token;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function liveStream<T>(initial: T | undefined, subscribe: (send: (value: T) => void) => () => void): Response {
  let cleanup: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // One exit for every way a stream ends: cancelled, or found dead on a
  // write. Both the sink and the timer have to go, or the process keeps
  // ticking for a connection nobody is reading.
  const teardown = () => {
    cleanup?.();
    cleanup = undefined;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const stream = new ReadableStream<string>({
    start(controller) {
      const send = (value: T) => {
        try {
          controller.enqueue(`data: ${JSON.stringify(value)}\n\n`);
        } catch {
          // Consumer gone and cancel() never fired. Drop the sink here or
          // it stays in the fan-out set for the life of the process.
          teardown();
        }
      };
      // Subscribe before the baseline so a push that lands between the two
      // cannot be missed; nothing can run in between, but the order is the
      // one that stays correct if a send ever becomes async.
      cleanup = subscribe(send);
      // Poses have no meaningful baseline: the first real frame is the
      // first robot to report.
      if (initial !== undefined) send(initial);
      // SSE comment keepalive: idle connections get reaped otherwise,
      // surfacing as ERR_INCOMPLETE_CHUNKED_ENCODING in the browser.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(`: ping\n\n`);
        } catch {
          teardown();
        }
      }, 15_000);
    },
    cancel() {
      teardown();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function fanOut<T>(sinks: Set<(value: T) => void>, send: (value: T) => void): () => void {
  sinks.add(send);
  return () => {
    sinks.delete(send);
  };
}

/**
 * A pose plus when it landed. A robot that stopped reporting is not
 * where it was last seen — it is gone — so anything that reasons about
 * where robots *are* has to be able to tell the two apart.
 */
export interface TrackedPose extends RobotPose {
  seenAt: number;
}

/** How long a pose is taken as describing where a robot currently is. */
export const DEFAULT_POSE_TTL_MS = 30_000;

/** Whether a pose still describes where the robot is, as of `now`. */
export function isFresh(pose: TrackedPose, now: number, ttlMs: number): boolean {
  return now - pose.seenAt < ttlMs;
}

/** Poses that arrived recently enough to still describe the present. */
export function freshPoses(
  poses: Iterable<TrackedPose>,
  now: number,
  ttlMs: number,
): TrackedPose[] {
  return [...poses].filter((p) => isFresh(p, now, ttlMs));
}

/** Latest untouched state body per robot (on-demand inspection). */
export interface TrackedState {
  manufacturer: string;
  serialNumber: string;
  receivedAt: number;
  body: unknown;
}

/** A pickup→dropoff job: queued until a free robot takes it. */
export interface TaskView {
  id: string;
  pickup: string;
  dropoff: string;
  status: "queued" | "assigned" | "done" | "failed";
  assignee?: string;
  /** Fleet order id once dispatched — the key into order history. */
  orderId?: string;
  reason?: string;
  createdAt: number;
}

/** Terminal tasks retained per site (queued/assigned never dropped). */
export const MAX_RETAINED_TASKS = 200;

let taskCounter = 1;

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
  poses: Map<string, TrackedPose>;
  tasks: Map<string, TaskView>;
  poseTtlMs: number;
}

/**
 * Assign queued tasks to the nearest free robot with a fresh pose.
 * Idempotent: safe to run on every order event and every submit.
 * Terminal tasks (done/failed) accumulate only up to MAX_RETAINED_TASKS —
 * the orders history stream is the durable record.
 */
const pumping = new WeakSet<Map<string, TaskView>>();

export function pumpSiteTasks(pump: TaskPump): void {
  // dispatch() emits onOrders synchronously, which calls this again while
  // the loop below is still walking `tasks` — and the retention sweep
  // deletes from that same map. Run the nested call after this one
  // instead, so there is only ever one walker.
  if (pumping.has(pump.tasks)) return;
  pumping.add(pump.tasks);
  try {
    assignQueuedTasks(pump);
  } finally {
    pumping.delete(pump.tasks);
  }
}

function assignQueuedTasks({ site, fleet, poses, tasks, poseTtlMs }: TaskPump): void {
  const now = Date.now();
  const byId = new Map(site.nodes.map((n) => [n.id, n]));
  for (const task of [...tasks.values()]) {
    if (task.status !== "queued") continue;
    const pickup = byId.get(task.pickup);
    const drop = byId.get(task.dropoff);
    if (!pickup || !drop) {
      task.status = "failed";
      task.reason = `unknown pickup or dropoff node`;
      continue;
    }
    let best: { serial: string; manufacturer: string; pose: TrackedPose; d: number } | undefined;
    for (const [serial, pose] of poses) {
      if (!isFresh(pose, now, poseTtlMs) || fleet.isBusy(serial)) continue;
      const d = (pose.x - pickup.x) ** 2 + (pose.y - pickup.y) ** 2;
      if (!best || d < best.d) best = { serial, manufacturer: pose.manufacturer, pose, d };
    }
    if (!best) continue;
    const path = shortestPath(site, task.pickup, task.dropoff);
    if (!path) {
      task.status = "failed";
      task.reason = `no route from "${task.pickup}" to "${task.dropoff}"`;
      continue;
    }
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

/** Live per-site fleet: locks, dispatcher, and stream fan-out. */
export interface SiteContext extends SiteFleet {
  lockSubs: Set<(snapshot: LockSnapshot) => void>;
  orderSubs: Set<(orders: ActiveOrder[]) => void>;
  historySubs: Set<(history: OrderHistory[]) => void>;
  poseSubs: Set<(pose: RobotPose) => void>;
  connSubs: Set<(conns: RobotConnection[]) => void>;
  /** Latest pose per robot, with the time it arrived. See TrackedPose. */
  poses: Map<string, TrackedPose>;
  /** Latest master-tracked connection state per robot. */
  conns: Map<string, RobotConnection>;
  /** Latest raw state body per robot (one entry each — bounded by design). */
  rawStates: Map<string, TrackedState>;
  /** Pickup→dropoff jobs (queued until the pump assigns a free robot). */
  tasks: Map<string, TaskView>;
}

export async function buildSiteContexts(
  sites: Map<string, Site>,
  options: {
    brokerUrl?: string;
    interfaceName?: string;
    log?: (line: string) => void;
    poseTtlMs?: number;
  } = {},
): Promise<Map<string, SiteContext>> {
  const poseTtlMs = options.poseTtlMs ?? DEFAULT_POSE_TTL_MS;
  if (options.interfaceName && sites.size > 1) {
    throw new Error(
      `interfaceName overrides every site, so ${sites.size} sites would share one VDA topic namespace; ` +
        "drop it or point SITES_DIR at a single site",
    );
  }
  const log = options.log ?? ((line) => console.log(line));
  const contexts = new Map<string, SiteContext>();
  for (const [name, site] of sites) {
    const interfaceName = options.interfaceName ?? name;
    const via = options.brokerUrl ?? "memory bus";
    const lockSubs = new Set<(snapshot: LockSnapshot) => void>();
    const orderSubs = new Set<(orders: ActiveOrder[]) => void>();
    const historySubs = new Set<(history: OrderHistory[]) => void>();
    const poseSubs = new Set<(pose: RobotPose) => void>();
    const connSubs = new Set<(conns: RobotConnection[]) => void>();
    const poses = new Map<string, TrackedPose>();
    const conns = new Map<string, RobotConnection>();
    const rawStates = new Map<string, TrackedState>();
    const tasks = new Map<string, TaskView>();
    const fleet = await bootSiteFleet(
      site,
      interfaceName,
      {
        onLocks: (snapshot) => {
          for (const send of [...lockSubs]) send(snapshot);
        },
        onOrders: (orders) => {
          for (const send of [...orderSubs]) send(orders);
          // A lifecycle end frees a robot — the moment queued tasks move.
          pumpSiteTasks({ site, fleet: fleet.fleet, poses, tasks, poseTtlMs });
        },
        onHistory: (history) => {
          for (const send of [...historySubs]) send(history);
        },
      },
      options.brokerUrl ? { brokerUrl: options.brokerUrl } : {},
    );
    fleet.master.registerConnectionStateChange((state, previous) => {
      log(`site ${name}: broker ${previous} -> ${state} (${via})`);
    });
    // Keep the unsubscribe: a discarded one leaves the pose subscription
    // live on a master the caller thinks it has stopped.
    const stopPoses = await watchRobots(fleet.master, undefined, (pose) => {
      const seenAt = Date.now();
      // Only a robot that was absent (new, or swept as stale) can change
      // what the pump can do; pumping on every state frame would run it
      // several times a second per robot for nothing.
      const previous = poses.get(pose.serialNumber);
      const wasKnown = previous !== undefined && isFresh(previous, seenAt, poseTtlMs);
      poses.set(pose.serialNumber, { ...pose, seenAt });
      // Drop robots that stopped reporting, so the map cannot grow for
      // the life of the process and stale entries cannot hold a spot.
      for (const [serial, tracked] of poses) {
        if (!isFresh(tracked, seenAt, poseTtlMs)) poses.delete(serial);
      }
      for (const send of [...poseSubs]) send(pose);
      // A robot coming back into view is the other way work becomes
      // assignable. Without this a task queued while every robot was
      // busy or silent waits for an unrelated order to end.
      if (!wasKnown) pumpSiteTasks({ site, fleet: fleet.fleet, poses, tasks, poseTtlMs });
    });
    // One subscription per master: the lib chains track handlers
    // permanently, so this must not run per stream.
    const stopConns = watchConnections(fleet.master, (conn) => {
      conns.set(conn.serialNumber, conn);
      const all = [...conns.values()];
      for (const send of [...connSubs]) send(all);
    });
    const stopStates = await watchStates(fleet.master, undefined, (state) => {
      const receivedAt = Date.now();
      rawStates.set(state.serialNumber, { ...state, receivedAt });
      // Same bound as poses: one body per robot, stale ones dropped.
      for (const [serial, tracked] of rawStates) {
        if (receivedAt - tracked.receivedAt >= poseTtlMs) rawStates.delete(serial);
      }
    });
    log(`site ${name}: interface ${interfaceName} via ${via}`);
    contexts.set(name, {
      ...fleet,
      lockSubs,
      orderSubs,
      historySubs,
      poseSubs,
      connSubs,
      poses,
      conns,
      rawStates,
      tasks,
      stop: async () => {
        stopConns();
        stopStates();
        stopPoses();
        await fleet.stop();
      },
    });
  }
  return contexts;
}

function siteGuard(
  contexts: Map<string, SiteContext>,
  me: { sites: string[] },
  name: string,
): Site {
  const ctx = contexts.get(name);
  if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
  if (!me.sites.includes(name)) throw Object.assign(new Error("forbidden site"), { status: 403 });
  return ctx.site;
}

/** Build the API without listening (exported for Eden Treaty typing). */
export function buildApp(
  auth: Auth,
  contexts: Map<string, SiteContext>,
  options: {
    defaultManufacturer?: string;
    loginStartPerMin?: number;
    loginFinishPerMin?: number;
    trustProxyHeader?: boolean;
    poseTtlMs?: number;
  } = {},
) {
  const defaultManufacturer = options.defaultManufacturer ?? "RobotCompany";
  const poseTtlMs = options.poseTtlMs ?? DEFAULT_POSE_TTL_MS;
  const trustProxyHeader = options.trustProxyHeader ?? false;
  const startLimiter = new RateLimiter({ limit: options.loginStartPerMin ?? 30, windowMs: 60_000 });
  const finishLimiter = new RateLimiter({ limit: options.loginFinishPerMin ?? 60, windowMs: 60_000 });
  return new Elysia()
    .onError(({ error, set }) => {
      const status = (error as { status?: number }).status ?? 401;
      set.status = status;
      // Errors skip onAfterHandle, so set CORS here too — otherwise the
      // browser hides the real status behind an opaque CORS failure.
      set.headers["Access-Control-Allow-Origin"] = "*";
      return { error: (error as Error).message };
    })
    .onAfterHandle(({ set }) => {
      set.headers["Access-Control-Allow-Origin"] = "*";
    })
    .options("/api/*", ({ set }) => {
      set.status = 204;
      set.headers["Access-Control-Allow-Headers"] = "authorization, content-type";
      set.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      return null;
    })
    .get("/api/health", () => ({ ok: true }))
    .post("/api/login/start", ({ body, headers, server, request }) => {
      limited(startLimiter, clientKey(headers, server?.requestIP(request)?.address, trustProxyHeader));
      const username = (body as { username?: unknown } | null)?.username;
      if (typeof username !== "string")
        throw Object.assign(new Error("username required"), { status: 400 });
      return auth.start(username);
    })
    .post("/api/login/finish", ({ body, headers, server, request }) => {
      limited(finishLimiter, clientKey(headers, server?.requestIP(request)?.address, trustProxyHeader));
      const input = (body ?? {}) as Record<string, unknown>;
      for (const key of ["serverEphemeral", "clientEphemeral", "proof"]) {
        if (typeof input[key] !== "string") {
          throw Object.assign(new Error(`${key} required`), { status: 400 });
        }
      }
      return auth.finish(
        input as { serverEphemeral: string; clientEphemeral: string; proof: string },
      );
    })
    .get("/api/me", async ({ headers }) => auth.me(bearerFromHeaders(headers)))
    .get("/api/sites", async ({ headers }) => ({ sites: (await auth.me(bearerFromHeaders(headers))).sites }))
    .get("/api/sites/:name/map", async ({ headers, params }) => {
      const me = await auth.me(bearerFromHeaders(headers));
      return siteGuard(contexts, me, decodeURIComponent(params.name));
    })
    .get("/api/sites/:name/:stream/stream", async ({ headers, params, query }) => {
      // EventSource cannot send headers: query ?token= or Bearer.
      const token =
        typeof query.token === "string" && query.token
          ? query.token
          : bearerFromHeaders(headers);
      // Authenticate first: answering 404 for an unknown site before
      // checking the token lets anyone enumerate site names.
      let me: { username: string; sites: string[] };
      try {
        me = await auth.me(token);
      } catch {
        throw Object.assign(new Error("invalid session"), { status: 401 });
      }
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      if (params.stream === "locks")
        return liveStream(ctx.locks.snapshot(), (send) => fanOut(ctx.lockSubs, send));
      if (params.stream === "orders")
        return liveStream(ctx.fleet.activeOrderList(), (send) => fanOut(ctx.orderSubs, send));
      if (params.stream === "history")
        return liveStream(ctx.fleet.orderHistory(), (send) => fanOut(ctx.historySubs, send));
      if (params.stream === "poses")
        return liveStream<RobotPose>(undefined, (send) => fanOut(ctx.poseSubs, send));
      if (params.stream === "connections")
        return liveStream([...ctx.conns.values()], (send) => fanOut(ctx.connSubs, send));
      throw Object.assign(new Error("unknown stream"), { status: 404 });
    })
    .post("/api/logout", async ({ headers }) => {
      await auth.logout(bearerFromHeaders(headers));
      return { ok: true };
    })
    .post("/api/sites/:name/orders/cancel", async ({ headers, params, body }) => {
      // Authenticate first: a 404 before the token check would let anyone
      // enumerate site names.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const serialNumber = (body as { serialNumber?: unknown } | null)?.serialNumber;
      if (typeof serialNumber !== "string" || !serialNumber) {
        throw Object.assign(new Error("serialNumber required"), { status: 400 });
      }
      // The robot's own reported maker, not a guess: a fleet with two
      // makers would otherwise cancel against the wrong topic.
      const manufacturer = ctx.poses.get(serialNumber)?.manufacturer ?? defaultManufacturer;
      try {
        await ctx.fleet.cancel({ manufacturer, serialNumber });
      } catch (error: unknown) {
        if (/no active order/.test((error as Error).message)) {
          throw Object.assign(error as object, { status: 404 });
        }
        throw error;
      }
      return { ok: true };
    })
    .post("/api/sites/:name/park", async ({ headers, params, body }) => {
      // Authenticate first: a 404 before the token check would let anyone
      // enumerate site names.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const input = (body ?? {}) as { serialNumber?: unknown; spotId?: unknown };
      if (typeof input.serialNumber !== "string" || !input.serialNumber) {
        throw Object.assign(new Error("serialNumber required"), { status: 400 });
      }
      const now = Date.now();
      const pose = ctx.poses.get(input.serialNumber);
      if (!pose || !isFresh(pose, now, poseTtlMs) || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) {
        throw Object.assign(new Error("no recent pose for robot"), { status: 404 });
      }
      const spots = ctx.site.parking ?? [];
      const spot =
        typeof input.spotId === "string"
          ? spots.find((s) => s.id === input.spotId)
          : freeSpot(
              spots,
              // Only robots reporting now hold a spot. Counting the ones
              // that went offline refuses spots that are actually free.
              occupiedSpots(spots, freshPoses(ctx.poses.values(), now, poseTtlMs)),
              pose,
            );
      if (!spot) throw Object.assign(new Error("no free parking spot"), { status: 409 });
      ctx.fleet
        .park(
          { manufacturer: pose.manufacturer, serialNumber: input.serialNumber },
          spot,
          { from: pose },
        )
        .catch((error: unknown) => console.warn("park failed", error));
      return { ok: true, spot: spot.id };
    })
    .post("/api/sites/:name/park-many", async ({ headers, params, body }) => {
      // Bulk park: one call clears N robots into free spots (optionally one
      // zone). Accepted, not awaited — same fire-and-forget as single park.
      // Per-robot failures ride along in `failed`, never abort the batch.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const input = (body ?? {}) as { serialNumbers?: unknown; zone?: unknown };
      if (
        !Array.isArray(input.serialNumbers) ||
        input.serialNumbers.length === 0 ||
        !input.serialNumbers.every((s) => typeof s === "string" && s)
      ) {
        throw Object.assign(new Error("non-empty serialNumbers required"), { status: 400 });
      }
      if (input.zone !== undefined && (typeof input.zone !== "string" || !input.zone)) {
        throw Object.assign(new Error("zone must be a non-empty string"), { status: 400 });
      }
      const now = Date.now();
      const fresh = (serial: string) => {
        const pose = ctx.poses.get(serial);
        return pose &&
          isFresh(pose, now, poseTtlMs) &&
          Number.isFinite(pose.x) &&
          Number.isFinite(pose.y)
          ? pose
          : undefined;
      };
      const spots = (ctx.site.parking ?? []).filter(
        (s) => input.zone === undefined || s.zone === input.zone,
      );
      // Assigned spots hold for the rest of the batch, so two robots never
      // get the same one. Sequential on purpose: deterministic assignment.
      const taken = new Set<string>();
      const parked: Array<{ serialNumber: string; spot: string }> = [];
      const failed: Array<{ serialNumber: string; error: string }> = [];
      for (const serialNumber of input.serialNumbers as string[]) {
        const pose = fresh(serialNumber);
        if (!pose) {
          failed.push({ serialNumber, error: "no recent pose for robot" });
          continue;
        }
        const spot = freeSpot(
          spots.filter((s) => !taken.has(s.id)),
          occupiedSpots(spots, freshPoses(ctx.poses.values(), now, poseTtlMs)),
          pose,
        );
        if (!spot) {
          failed.push({ serialNumber, error: "no free parking spot" });
          continue;
        }
        taken.add(spot.id);
        ctx.fleet
          .park({ manufacturer: pose.manufacturer, serialNumber }, spot, { from: pose })
          .catch((error: unknown) => console.warn("park failed", error));
        parked.push({ serialNumber, spot: spot.id });
      }
      return { ok: true, parked, failed };
    })
    .get("/api/sites/:name/robots/:serial/state", async ({ headers, params }) => {
      // On-demand raw state: the full VehicleState body the poses stream
      // projects from. Debug and acceptance use; dashboards use poses.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const serial = decodeURIComponent(params.serial);
      const tracked = ctx.rawStates.get(serial);
      if (!tracked || Date.now() - tracked.receivedAt >= poseTtlMs) {
        throw Object.assign(new Error("no recent state for robot"), { status: 404 });
      }
      return {
        manufacturer: tracked.manufacturer,
        serialNumber: tracked.serialNumber,
        receivedAt: tracked.receivedAt,
        state: tracked.body,
      };
    })
    .post("/api/sites/:name/tasks", async ({ headers, params, body }) => {
      // Queue a pickup→dropoff job. The pump assigns the nearest free
      // robot; progress rides the orders/history streams, completion
      // lands here via GET /tasks.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const input = (body ?? {}) as { pickup?: unknown; dropoff?: unknown };
      if (typeof input.pickup !== "string" || !input.pickup) {
        throw Object.assign(new Error("pickup required"), { status: 400 });
      }
      if (typeof input.dropoff !== "string" || !input.dropoff) {
        throw Object.assign(new Error("dropoff required"), { status: 400 });
      }
      const ids = new Set(ctx.site.nodes.map((n) => n.id));
      if (!ids.has(input.pickup) || !ids.has(input.dropoff)) {
        throw Object.assign(new Error("pickup and dropoff must be known nodes"), { status: 400 });
      }
      if (!shortestPath(ctx.site, input.pickup, input.dropoff)) {
        throw Object.assign(
          new Error(`no route from "${input.pickup}" to "${input.dropoff}"`),
          { status: 409 },
        );
      }
      const id = `task-${taskCounter++}`;
      ctx.tasks.set(id, {
        id,
        pickup: input.pickup,
        dropoff: input.dropoff,
        status: "queued",
        createdAt: Date.now(),
      });
      pumpSiteTasks({ site: ctx.site, fleet: ctx.fleet, poses: ctx.poses, tasks: ctx.tasks, poseTtlMs });
      return { ok: true, taskId: id };
    })
    .get("/api/sites/:name/tasks", async ({ headers, params }) => {
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      return { tasks: [...ctx.tasks.values()] };
    })
    .delete("/api/sites/:name/tasks/:taskId", async ({ headers, params }) => {
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const id = decodeURIComponent(params.taskId);
      const task = ctx.tasks.get(id);
      if (!task) throw Object.assign(new Error("unknown task"), { status: 404 });
      // Assigned tasks are orders in flight — cancel the order instead.
      if (task.status !== "queued") {
        throw Object.assign(new Error("only queued tasks can be withdrawn"), { status: 409 });
      }
      ctx.tasks.delete(id);
      return { ok: true };
    })
    .post("/api/sites/:name/orders", async ({ headers, params, body }) => {
      // Authenticate first: a 404 before the token check would let anyone
      // enumerate site names.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const input = (body ?? {}) as {
        manufacturer?: unknown;
        serialNumber?: unknown;
        waypoints?: unknown;
      };
      const manufacturer =
        typeof input.manufacturer === "string" ? input.manufacturer : defaultManufacturer;
      if (typeof input.serialNumber !== "string" || !input.serialNumber) {
        throw Object.assign(new Error("serialNumber required"), { status: 400 });
      }
      if (!Array.isArray(input.waypoints) || input.waypoints.length === 0) {
        throw Object.assign(new Error("non-empty waypoints required"), { status: 400 });
      }
      const waypoints = input.waypoints.map((w, i) => {
        const point = w as { nodeId?: unknown; x?: unknown; y?: unknown };
        if (typeof point.nodeId !== "string" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          throw Object.assign(new Error(`waypoints[${i}] needs nodeId, x, y`), { status: 400 });
        }
        return { nodeId: point.nodeId, x: point.x as number, y: point.y as number };
      });
      // Accepted, not awaited: progress streams over locks/orders SSE.
      // Busy is refused synchronously; later failures ride the orders
      // feed and server logs.
      if (ctx.fleet.isBusy(input.serialNumber)) {
        throw Object.assign(
          new Error(`robot ${input.serialNumber} is busy — wait or cancel first`),
          { status: 409 },
        );
      }
      ctx.fleet
        .dispatch({ manufacturer, serialNumber: input.serialNumber }, waypoints)
        .catch((error: unknown) => console.warn("dispatch failed", error));
      return { ok: true };
    });
}

export type FleetApi = ReturnType<typeof buildApp>;

/** Boot the API. Returns the Bun server handle (call .stop() in tests). */
export async function serve(options: ServeOptions) {
  const store: SessionStore = options.sessionsFile
    ? new SqliteSessionStore(options.sessionsFile)
    : new MemorySessionStore();
  const auth = new Auth(await loadUsersFile(options.usersFile), {
    store,
    sessionTtlMs: options.sessionTtlMs,
    maxPendingChallenges: options.maxPendingChallenges,
    srp: options.srp,
  });
  const purged = await auth.purge();
  if (purged.challenges > 0 || purged.sessions > 0) {
    console.log(`sessions: purged ${purged.challenges} challenges, ${purged.sessions} sessions`);
  }
  const contexts = await buildSiteContexts(loadSites(options.sitesDir ?? "data/seed/sites"), {
    brokerUrl: options.brokerUrl,
    interfaceName: options.interfaceName,
    poseTtlMs: options.poseTtlMs,
  });
  const app = buildApp(auth, contexts, {
    defaultManufacturer: options.defaultManufacturer,
    poseTtlMs: options.poseTtlMs,
    loginStartPerMin: options.loginStartPerMin,
    loginFinishPerMin: options.loginFinishPerMin,
    trustProxyHeader: options.trustProxyHeader,
  });
  if (options.tlsCert && options.tlsKey) {
    app.listen({
      port: options.port ?? 4000,
      tls: { cert: Bun.file(options.tlsCert), key: Bun.file(options.tlsKey) },
    });
  } else {
    app.listen(options.port ?? 4000);
  }

  const server = app.server!;
  /** Stop the HTTP server and every site fleet it booted. */
  const stop = async () => {
    server.stop(true);
    for (const ctx of contexts.values()) await ctx.stop();
    await store.close?.();
  };
  return { server, auth, port: server.port, contexts, stop };
}
