import { describe, expect, test } from "bun:test";
import { Auth } from "../src/auth.js";
import { buildApp } from "../src/serve.js";
import { testSrp } from "./helpers.js";

describe("CORS preflight", () => {
  const app = buildApp(new Auth([], { srp: testSrp }), new Map());

  async function allowedMethods(path: string, method: string): Promise<string[]> {
    const res = await app.handle(
      new Request(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization",
        },
      }),
    );
    expect(res.status).toBe(204);
    return (res.headers.get("Access-Control-Allow-Methods") ?? "").split(/,\s*/);
  }

  test("a cross-origin task withdraw passes preflight", async () => {
    // The UI (:3000) calls the API (:4000) cross-origin, so the browser
    // preflights the DELETE. Without it in the allow list, every withdraw
    // failed before the request was sent.
    expect(await allowedMethods("/api/sites/coalescent/tasks/t1", "DELETE")).toContain("DELETE");
  });

  test("every method an /api route serves is allowed", async () => {
    // Guards the next non-GET/POST route, not just this one.
    const served = new Set(
      app.routes
        .filter((r) => r.path.startsWith("/api/") && r.method !== "OPTIONS")
        .map((r) => r.method.toUpperCase()),
    );
    const allowed = await allowedMethods("/api/health", "GET");
    expect([...served].filter((m) => !allowed.includes(m))).toEqual([]);
  });
});
