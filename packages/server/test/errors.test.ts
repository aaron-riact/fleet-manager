import { describe, expect, spyOn, test } from "bun:test";
import { Auth } from "../src/auth.js";
import { buildApp } from "../src/serve.js";
import type { SiteContext } from "../src/serve.js";
import { testLogin, testSrp, testUser } from "./helpers.js";

/** Just enough of a site for the cancel route; its fleet fails like a broker outage. */
function brokenSite(): SiteContext {
  return {
    site: { name: "coalescent", nodes: [], links: [] },
    poses: new Map(),
    fleet: {
      cancel: async () => {
        throw new Error("mqtt client disconnected at 10.0.0.7:1883");
      },
    },
  } as unknown as SiteContext;
}

async function setup() {
  const user = await testUser("err@cmr", "s3cret", ["coalescent"]);
  const auth = new Auth([user], { srp: testSrp });
  const app = buildApp(auth, new Map([["coalescent", brokenSite()]]));
  const statuses: number[] = [];
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    statuses.push(res.status);
    return res;
  };
  return { post, statuses };
}

describe("error statuses", () => {
  test("an unexpected failure is a 500 that keeps its details in the log", async () => {
    // onError used to default to 401 and echo the raw message: a broker
    // outage read as "Unauthorized" and leaked internals to the client.
    const { post } = await setup();
    const token = await testLogin(post, "err@cmr", "s3cret");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post("/api/sites/coalescent/orders/cancel", { serialNumber: "r1" }, token);
      expect(res.status).toBe(500);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("internal error");
      const [, logged0] = logged.mock.calls[0] ?? [];
      expect((logged0 as Error).message).toContain("10.0.0.7");
    } finally {
      logged.mockRestore();
    }
  });

  test("auth failures stay 401 without the old default", async () => {
    const { post, statuses } = await setup();
    await testLogin(post, "err@cmr", "wrong");
    // start succeeds, finish refuses the proof
    expect(statuses).toEqual([200, 401]);
    expect((await post("/api/login/start", { username: "nobody@cmr" })).status).toBe(401);
    const replay = await post("/api/login/finish", {
      serverEphemeral: "ab",
      clientEphemeral: "cd",
      proof: "ef",
    });
    expect(replay.status).toBe(401);
    const stale = await post("/api/sites/coalescent/orders/cancel", { serialNumber: "r1" }, "not-a-token");
    expect(stale.status).toBe(401);
  });
});
