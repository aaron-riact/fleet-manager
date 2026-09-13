import { loadUsersFile } from "./usersFile.js";
import { loadSites } from "./sites.js";
import { Auth } from "./auth.js";

export interface ServeOptions {
  port?: number;
  usersFile: string;
  sitesDir?: string;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw Object.assign(new Error("malformed JSON body"), { status: 400 });
  }
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
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

function failure(error: unknown): Response {
  const status = (error as { status?: number }).status ?? 401;
  return json({ error: (error as Error).message }, status);
}

/** Boot the API. Returns the Bun server handle (call .stop() in tests). */
export async function serve(options: ServeOptions) {
  const auth = new Auth(await loadUsersFile(options.usersFile));
  const sites = loadSites(options.sitesDir ?? "data/seed/sites");
  const server = Bun.serve({
    port: options.port ?? 4000,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "authorization, content-type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          },
        });
      }
      try {
        if (req.method === "GET" && url.pathname === "/api/health") {
          return json({ ok: true });
        }
        if (req.method === "POST" && url.pathname === "/api/login/start") {
          const body = (await readJson(req)) as { username?: unknown };
          if (typeof body.username !== "string") throw Object.assign(new Error("username required"), { status: 400 });
          return json(await auth.start(body.username));
        }
        if (req.method === "POST" && url.pathname === "/api/login/finish") {
          const body = (await readJson(req)) as Record<string, unknown>;
          for (const key of ["serverEphemeral", "clientEphemeral", "proof"]) {
            if (typeof body[key] !== "string") {
              throw Object.assign(new Error(`${key} required`), { status: 400 });
            }
          }
          return json(
            await auth.finish(body as { serverEphemeral: string; clientEphemeral: string; proof: string }),
          );
        }
        if (req.method === "GET" && url.pathname === "/api/me") {
          return json(auth.me(bearer(req)));
        }
        if (req.method === "GET" && url.pathname === "/api/sites") {
          return json({ sites: auth.me(bearer(req)).sites });
        }
        {
          const mapMatch = /^\/api\/sites\/([^/]+)\/map$/.exec(url.pathname);
          if (req.method === "GET" && mapMatch) {
            const me = auth.me(bearer(req));
            const name = decodeURIComponent(mapMatch[1]!);
            const site = sites.get(name);
            if (!site) return json({ error: "unknown site" }, 404);
            if (!me.sites.includes(name)) return json({ error: "forbidden site" }, 403);
            return json(site);
          }
        }
        if (req.method === "POST" && url.pathname === "/api/logout") {
          auth.logout(bearer(req));
          return json({ ok: true });
        }
        return json({ error: "not found" }, 404);
      } catch (error) {
        return failure(error);
      }
    },
  });
  return { server, auth, port: server.port };
}
