import { describe, expect, test } from "bun:test";
import { Auth } from "../src/auth.js";
import { buildApp } from "../src/serve.js";
import type { SiteContext } from "../src/serve.js";
import { MemorySessionStore } from "../src/sessions.js";
import { testLogin, testSrp, testUser } from "./helpers.js";

/** Just enough of a site for the locks stream. */
function lockSite(): SiteContext {
  return {
    site: { name: "coalescent", nodes: [], links: [] },
    locks: { snapshot: () => ({ nodeLocks: [], edgeLocks: [] }) },
    lockSubs: new Set(),
  } as unknown as SiteContext;
}

/** A store whose reads can be made to fail, like a SQLite fault. */
class FlakyStore extends MemorySessionStore {
  failing = false;
  override async getSession(token: string) {
    if (this.failing) throw new Error("database is locked");
    return super.getSession(token);
  }
}

async function setup() {
  const store = new FlakyStore();
  const auth = new Auth([await testUser("sse@cmr", "s3cret", ["coalescent"])], { srp: testSrp, store });
  const app = buildApp(auth, new Map([["coalescent", lockSite()]]), { streamHeartbeatMs: 20 });
  const post = (path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const token = await testLogin(post, "sse@cmr", "s3cret");
  const res = await app.handle(
    new Request(`http://localhost/api/sites/coalescent/locks/stream?token=${encodeURIComponent(token)}`),
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  return { auth, store, token, reader };
}

/** Reads until the stream ends; "open" if it is still going after `ms`. */
async function endsWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<"tick">((r) => setTimeout(() => r("tick"), deadline - Date.now())),
    ]);
    if (next !== "tick" && next.done) return "ended";
  }
  return "open";
}

describe("stream auth", () => {
  test("an open stream ends once its session is logged out", async () => {
    // Streams checked the token only when they opened: after logout, or
    // once the session expired, poses and orders kept flowing for good.
    const { auth, token, reader } = await setup();
    try {
      expect(await endsWithin(reader, 100)).toBe("open");
      await auth.logout(token);
      expect(await endsWithin(reader, 500)).toBe("ended");
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  test("a store fault does not drop the stream", async () => {
    // Closing on any error would send every client into a reconnect that
    // gets a 500, and EventSource gives up for good on a non-200.
    const { store, reader } = await setup();
    try {
      store.failing = true;
      expect(await endsWithin(reader, 200)).toBe("open");
    } finally {
      store.failing = false;
      await reader.cancel().catch(() => {});
    }
  });
});
