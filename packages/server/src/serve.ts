import { Elysia } from "elysia";
import { bootSiteFleet, watchRobots } from "@fleet-manager/vda";
import type { ActiveOrder, RobotPose, SiteFleet } from "@fleet-manager/vda";
import type { LockSnapshot, Site } from "@fleet-manager/core";
import { loadUsersFile } from "./usersFile.js";
import { loadSites } from "./sites.js";
import { Auth } from "./auth.js";

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

/** Live per-site fleet: locks, dispatcher, and stream fan-out. */
export interface SiteContext extends SiteFleet {
  lockSubs: Set<(snapshot: LockSnapshot) => void>;
  orderSubs: Set<(orders: ActiveOrder[]) => void>;
  poseSubs: Set<(pose: RobotPose) => void>;
}

export async function buildSiteContexts(
  sites: Map<string, Site>,
  options: { brokerUrl?: string; interfaceName?: string; log?: (line: string) => void } = {},
): Promise<Map<string, SiteContext>> {
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
    const poseSubs = new Set<(pose: RobotPose) => void>();
    const fleet = await bootSiteFleet(
      site,
      interfaceName,
      {
        onLocks: (snapshot) => {
          for (const send of [...lockSubs]) send(snapshot);
        },
        onOrders: (orders) => {
          for (const send of [...orderSubs]) send(orders);
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
      for (const send of [...poseSubs]) send(pose);
    });
    log(`site ${name}: interface ${interfaceName} via ${via}`);
    contexts.set(name, {
      ...fleet,
      lockSubs,
      orderSubs,
      poseSubs,
      stop: async () => {
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
  options: { defaultManufacturer?: string } = {},
) {
  const defaultManufacturer = options.defaultManufacturer ?? "RobotCompany";
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
    .post("/api/login/start", ({ body }) => {
      const username = (body as { username?: unknown } | null)?.username;
      if (typeof username !== "string")
        throw Object.assign(new Error("username required"), { status: 400 });
      return auth.start(username);
    })
    .post("/api/login/finish", ({ body }) => {
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
    .get("/api/me", ({ headers }) => auth.me(bearerFromHeaders(headers)))
    .get("/api/sites", ({ headers }) => ({ sites: auth.me(bearerFromHeaders(headers)).sites }))
    .get("/api/sites/:name/map", ({ headers, params }) => {
      const me = auth.me(bearerFromHeaders(headers));
      return siteGuard(contexts, me, decodeURIComponent(params.name));
    })
    .get("/api/sites/:name/:stream/stream", ({ headers, params, query }) => {
      // EventSource cannot send headers: query ?token= or Bearer.
      const token =
        typeof query.token === "string" && query.token
          ? query.token
          : bearerFromHeaders(headers);
      // Authenticate first: answering 404 for an unknown site before
      // checking the token lets anyone enumerate site names.
      let me: { username: string; sites: string[] };
      try {
        me = auth.me(token);
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
      if (params.stream === "poses")
        return liveStream<RobotPose>(undefined, (send) => fanOut(ctx.poseSubs, send));
      throw Object.assign(new Error("unknown stream"), { status: 404 });
    })
    .post("/api/logout", ({ headers }) => {
      auth.logout(bearerFromHeaders(headers));
      return { ok: true };
    })
    .post("/api/sites/:name/orders", async ({ headers, params, body }) => {
      // Authenticate first: a 404 before the token check would let anyone
      // enumerate site names.
      const me = auth.me(bearerFromHeaders(headers));
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
  const auth = new Auth(await loadUsersFile(options.usersFile));
  const contexts = await buildSiteContexts(loadSites(options.sitesDir ?? "data/seed/sites"), {
    brokerUrl: options.brokerUrl,
    interfaceName: options.interfaceName,
  });
  const app = buildApp(auth, contexts, { defaultManufacturer: options.defaultManufacturer });
  app.listen(options.port ?? 4000);

  const server = app.server!;
  /** Stop the HTTP server and every site fleet it booted. */
  const stop = async () => {
    server.stop(true);
    for (const ctx of contexts.values()) await ctx.stop();
  };
  return { server, auth, port: server.port, contexts, stop };
}
