import { loadUsersFile } from "./usersFile.js";
import { Auth } from "./auth.js";

export interface ServeOptions {
  port?: number;
  usersFile: string;
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
  return Response.json(data, { status });
}

function failure(error: unknown): Response {
  const status = (error as { status?: number }).status ?? 401;
  return json({ error: (error as Error).message }, status);
}

/** Boot the API. Returns the Bun server handle (call .stop() in tests). */
export async function serve(options: ServeOptions) {
  const auth = new Auth(await loadUsersFile(options.usersFile));
  const server = Bun.serve({
    port: options.port ?? 4000,
    async fetch(req) {
      const url = new URL(req.url);
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
