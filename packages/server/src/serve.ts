import { Elysia } from "elysia";
import { buildLocks } from "@fleet-manager/core";
import type { Site } from "@fleet-manager/core";
import { loadUsersFile } from "./usersFile.js";
import { loadSites } from "./sites.js";
import { Auth } from "./auth.js";

export interface ServeOptions {
  port?: number;
  usersFile: string;
  sitesDir?: string;
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

function sse(payload: unknown): Response {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  return new Response(frame, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function siteGuard(
  sites: ReturnType<typeof loadSites>,
  me: { sites: string[] },
  name: string,
): Site {
  const site = sites.get(name);
  if (!site) throw Object.assign(new Error("unknown site"), { status: 404 });
  if (!me.sites.includes(name)) throw Object.assign(new Error("forbidden site"), { status: 403 });
  return site;
}

/** Build the API without listening (exported for Eden Treaty typing). */
export function buildApp(auth: Auth, sites: Map<string, Site>) {
  return new Elysia()
    .onError(({ error, set }) => {
      const status = (error as { status?: number }).status ?? 401;
      set.status = status;
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
      return siteGuard(sites, me, decodeURIComponent(params.name));
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
      const site = sites.get(decodeURIComponent(params.name));
      if (!site) throw Object.assign(new Error("unknown site"), { status: 404 });
      if (!me.sites.includes(site.name))
        throw Object.assign(new Error("forbidden site"), { status: 403 });
      // Baseline frame now; continuous push once the server runs a Fleet
      // (demo already proves the feed shape).
      if (params.stream === "locks") return sse(buildLocks(site).snapshot());
      if (params.stream === "orders") return sse([]);
      if (params.stream === "poses") return sse({ type: "poses", site: site.name, poses: [] });
      throw Object.assign(new Error("unknown stream"), { status: 404 });
    })
    .post("/api/logout", ({ headers }) => {
      auth.logout(bearerFromHeaders(headers));
      return { ok: true };
    });
}

export type FleetApi = ReturnType<typeof buildApp>;

/** Boot the API. Returns the Bun server handle (call .stop() in tests). */
export async function serve(options: ServeOptions) {
  const auth = new Auth(await loadUsersFile(options.usersFile));
  const sites = loadSites(options.sitesDir ?? "data/seed/sites");
  const app = buildApp(auth, sites);
  app.listen(options.port ?? 4000);

  const server = app.server!;
  return { server, auth, port: server.port };
}
