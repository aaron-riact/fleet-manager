import { Elysia } from "elysia";
import { bootSiteFleet, watchConnections, watchRobots, watchStates } from "@fleet-manager/vda";
import type { ActiveOrder, OrderHistory, RobotConnection, RobotPose, SiteFleet } from "@fleet-manager/vda";
import {
  DEFAULT_POSE_TTL_MS,
  addDemand,
  checkNode,
  checkRoutePair,
  consumeDemand,
  demandList,
  freeSpot,
  freshPoses,
  isFresh,
  nextTaskId,
  occupiedSpots,
  parkRoute,
  pumpSiteTasks,
} from "@fleet-manager/core";
import type { DemandCounts, LockSnapshot, Site, TaskView, ZoneDemand } from "@fleet-manager/core";
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

/** Latest untouched state body per robot (on-demand inspection). */
export interface TrackedState {
  manufacturer: string;
  serialNumber: string;
  receivedAt: number;
  body: unknown;
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
  /** Outstanding human-signalled demand per zone (bump endpoint, request endpoint consumes). */
  demands: DemandCounts;
  demandSubs: Set<(demands: ZoneDemand[]) => void>;
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
    // Single mutable record per site: endpoints update it in place so the
    // pump calls below always read live demand through this reference.
    const demands: DemandCounts = {};
    const demandSubs = new Set<(demands: ZoneDemand[]) => void>();
    // Robots currently being auto-parked, with the spot each is headed to.
    // Park resolves on arrival, so without this two completions could aim
    // two robots at the same spot.
    const parkingTargets = new Map<string, string>();
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
          pumpSiteTasks({ site, fleet: fleet.fleet, poses, tasks, demands, poseTtlMs });
        },
        onHistory: (history) => {
          for (const send of [...historySubs]) send(history);
        },
        onOrderDone: (serial) => {
          // Queued work gets first refusal on the robot we just freed.
          // This runs before onOrders (emitDone precedes emitOrders), and
          // parking marks the robot busy the moment it dispatches, so
          // leaving the pump until then sent it to a spot and back between
          // every job. The isBusy check below sees whatever it took.
          pumpSiteTasks({ site, fleet: fleet.fleet, poses, tasks, demands, poseTtlMs });
          // Finished tours clear the graph into parking, like the source:
          // idle robots wait off-graph holding nothing instead of sitting
          // on nodes other tours must route around. Skipped with no
          // parking, no fresh fix, a new tour already, or a park underway.
          const now = Date.now();
          const pose = poses.get(serial);
          if (
            !pose ||
            !isFresh(pose, now, poseTtlMs) ||
            !Number.isFinite(pose.x) ||
            !Number.isFinite(pose.y) ||
            fleet.fleet.isBusy(serial) ||
            parkingTargets.has(serial)
          ) {
            return;
          }
          const spots = site.parking ?? [];
          if (spots.length === 0) return;
          const taken = new Set(parkingTargets.values());
          const spot = freeSpot(
            spots.filter((s) => !taken.has(s.id)),
            occupiedSpots(spots, freshPoses(poses.values(), now, poseTtlMs)),
            pose,
          );
          if (!spot) return;
          parkingTargets.set(serial, spot.id);
          // Locked tour to the spot's entry with the parking leg appended
          // (same shape as driveLoop tours), so the robot follows the
          // network instead of free-driving through walls. Falls back to
          // a free-drive park only when no route exists.
          const route = parkRoute(site, pose, spot);
          const ride = route
            ? fleet.fleet.dispatch(
              { manufacturer: pose.manufacturer, serialNumber: serial },
              route,
              { from: pose, park: spot },
            )
            : fleet.fleet.park(
              { manufacturer: pose.manufacturer, serialNumber: serial },
              spot,
              { from: pose },
            );
          ride
            .catch((error: unknown) => console.warn("auto-park failed", error))
            .finally(() => {
              parkingTargets.delete(serial);
            });
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
      if (!wasKnown) pumpSiteTasks({ site, fleet: fleet.fleet, poses, tasks, demands, poseTtlMs });
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
      demands,
      demandSubs,
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

/**
 * Replace a site's demand record in place (never reassign: the pump
 * calls closed over the original reference) and fan the snapshot out.
 */
function setDemands(ctx: SiteContext, next: DemandCounts): ZoneDemand[] {
  for (const key of Object.keys(ctx.demands)) delete ctx.demands[key];
  Object.assign(ctx.demands, next);
  const all = demandList(ctx.demands);
  for (const send of [...ctx.demandSubs]) send(all);
  return all;
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
      if (params.stream === "demands")
        return liveStream(demandList(ctx.demands), (send) => fanOut(ctx.demandSubs, send));
      throw Object.assign(new Error("unknown stream"), { status: 404 });
    })
    .post("/api/sites/:name/demand", async ({ headers, params, body }) => {
      // Signal unit demand for a zone (+n) or reset it (0). Low-frequency
      // operator input; the request endpoint consumes units into tasks.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const input = (body ?? {}) as { zone?: unknown; count?: unknown };
      if (typeof input.zone !== "string" || !input.zone) {
        throw Object.assign(new Error("zone required"), { status: 400 });
      }
      if (typeof input.count !== "number" || !Number.isInteger(input.count) || input.count < 0) {
        throw Object.assign(new Error("count must be a non-negative integer"), { status: 400 });
      }
      setDemands(ctx, addDemand(ctx.demands, input.zone, input.count));
      return { ok: true, zone: input.zone, demand: ctx.demands[input.zone] };
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
      const issue = checkRoutePair(ctx.site, input.pickup, input.dropoff);
      if (issue) throw Object.assign(new Error(issue.message), { status: issue.status });
      // checkRoutePair proved both ends; the cast only tells TS what it proved.
      const pickup = input.pickup as string;
      const dropoff = input.dropoff as string;
      const id = nextTaskId();
      ctx.tasks.set(id, {
        id,
        pickup,
        dropoff,
        status: "queued",
        createdAt: Date.now(),
      });
      pumpSiteTasks({ site: ctx.site, fleet: ctx.fleet, poses: ctx.poses, tasks: ctx.tasks, demands: ctx.demands, poseTtlMs });
      return { ok: true, taskId: id };
    })
    .post("/api/sites/:name/tasks/request", async ({ headers, params, body }) => {
      // Dropoff-only request: demand that is not yet dispatchable. The
      // pickup gets attached later; the pump ignores requested tasks.
      // Consumes one unit of the zone's demand when given, so demand plus
      // requests plus in-flight work keep summing to total demand.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const input = (body ?? {}) as { dropoff?: unknown; zone?: unknown };
      const dropoffIssue = checkNode(ctx.site, "dropoff", input.dropoff);
      if (dropoffIssue) throw Object.assign(new Error(dropoffIssue.message), { status: dropoffIssue.status });
      if (input.zone !== undefined && (typeof input.zone !== "string" || !input.zone)) {
        throw Object.assign(new Error("zone must be a non-empty string"), { status: 400 });
      }
      const id = nextTaskId();
      ctx.tasks.set(id, {
        id,
        // checkNode proved the dropoff above; the cast tells TS what it proved.
        dropoff: input.dropoff as string,
        ...(input.zone === undefined ? {} : { zone: input.zone }),
        status: "requested",
        createdAt: Date.now(),
      });
      if (input.zone !== undefined) {
        setDemands(ctx, consumeDemand(ctx.demands, input.zone));
      }
      return { ok: true, taskId: id };
    })
    .post("/api/sites/:name/tasks/:taskId/pickup", async ({ headers, params, body }) => {
      // Attach the pickup that makes a request dispatchable.
      const me = await auth.me(bearerFromHeaders(headers));
      const ctx = contexts.get(decodeURIComponent(params.name));
      if (!ctx) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(ctx.site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      const id = decodeURIComponent(params.taskId);
      const task = ctx.tasks.get(id);
      if (!task) throw Object.assign(new Error("unknown task"), { status: 404 });
      if (task.status !== "requested") {
        throw Object.assign(new Error("only requested tasks take a pickup"), { status: 409 });
      }
      const input = (body ?? {}) as { pickup?: unknown };
      const pickupIssue = checkNode(ctx.site, "pickup", input.pickup);
      if (pickupIssue) throw Object.assign(new Error(pickupIssue.message), { status: pickupIssue.status });
      // checkNode proved the pickup; the cast tells TS what it proved.
      const pickup = input.pickup as string;
      const routeIssue = checkRoutePair(ctx.site, pickup, task.dropoff);
      if (routeIssue) throw Object.assign(new Error(routeIssue.message), { status: routeIssue.status });
      task.pickup = pickup;
      task.status = "queued";
      pumpSiteTasks({ site: ctx.site, fleet: ctx.fleet, poses: ctx.poses, tasks: ctx.tasks, demands: ctx.demands, poseTtlMs });
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
      // Withdrawing a request returns its demand unit: the need did not
      // go away just because nobody will drive it.
      if (task.status === "requested") {
        if (task.zone !== undefined) {
          setDemands(ctx, addDemand(ctx.demands, task.zone, 1));
        }
        ctx.tasks.delete(id);
        return { ok: true };
      }
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
        exit?: unknown;
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
      let exit: { x: number; y: number } | undefined;
      if (input.exit !== undefined) {
        const point = input.exit as { x?: unknown; y?: unknown };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          throw Object.assign(new Error("exit needs x, y"), { status: 400 });
        }
        exit = { x: point.x as number, y: point.y as number };
      }
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
        .dispatch({ manufacturer, serialNumber: input.serialNumber }, waypoints, { ...(exit ? { exit } : {}) })
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
