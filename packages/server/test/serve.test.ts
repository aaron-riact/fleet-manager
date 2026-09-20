import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgvController, VirtualAgvAdapter } from "vda-5050-lib";
import { serializeUsersFile } from "@fleet-manager/core";
import { testLogin, testSrp, testUser } from "./helpers.js";
import { attachMemoryTransport } from "@fleet-manager/vda";
import { serve } from "../src/serve.js";

async function boot(
  overrides: {
    loginStartPerMin?: number;
    trustProxyHeader?: boolean;
    poseTtlMs?: number;
  } = {},
) {
  const user = await testUser("http@cmr", "s3cret", ["coalescent"]);
  const dir = mkdtempSync(join(tmpdir(), "fleet-srv-"));
  const file = join(dir, "users.json");
  writeFileSync(file, serializeUsersFile([user]));
  const sitesDir = join(dir, "sites");
  mkdirSync(sitesDir);
  writeFileSync(
    join(sitesDir, "coalescent.json"),
    JSON.stringify({ name: "coalescent", nodes: [{ id: "a", x: 0, y: 0 }], links: [] }),
  );
  writeFileSync(
    join(sitesDir, "other.json"),
    JSON.stringify({ name: "other", nodes: [{ id: "b", x: 1, y: 1 }], links: [] }),
  );
  const { server, port, contexts, stop } = await serve({
    port: 0,
    usersFile: file,
    sitesDir,
    srp: testSrp,
    ...overrides,
  });
  const base = `http://localhost:${port}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    return { base, post, server, contexts, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

describe("HTTP API", () => {
  test("health, login, me, logout", async () => {
    const { post, base, server, stop } = await boot();
    try {
      expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });

      const preflight = await fetch(`${base}/api/login/start`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const step1 = await (await post("/api/login/start", { username: "http@cmr" })).json();
      const key = await testSrp.client.derivePrivateKey(step1.salt, "http@cmr", "s3cret");
      const eph = testSrp.client.generateEphemeral();
      const sess = await testSrp.client.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "http@cmr", key);
      const step2 = await post("/api/login/finish", {
        serverEphemeral: step1.serverEphemeral,
        clientEphemeral: eph.public,
        proof: sess.proof,
      });
      expect(step2.status).toBe(200);
      const { token, username, sites } = await step2.json();
      expect(username).toBe("http@cmr");

      const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(await me.json()).toEqual({ username, sites });

      const logout = await fetch(`${base}/api/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(logout.status).toBe(200);
      const meAfter = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(meAfter.status).toBe(401);
    } finally {
      await stop();
    }
  });

  test("unknown user and bad bodies are rejected", async () => {
    const { post, server, stop } = await boot();
    try {
      expect((await post("/api/login/start", { username: "nobody@cmr" })).status).toBe(401);
      expect((await post("/api/login/start", {})).status).toBe(400);
      expect((await post("/api/login/finish", { proof: "x" })).status).toBe(400);
    } finally {
      await stop();
    }
  });

  test("login/start rate limiting returns 429", async () => {
    const { post, server, stop } = await boot({ loginStartPerMin: 2 });
    try {
      expect((await post("/api/login/start", { username: "nobody@cmr" })).status).toBe(401);
      expect((await post("/api/login/start", { username: "nobody@cmr" })).status).toBe(401);
      const limited = await post("/api/login/start", { username: "nobody@cmr" });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "too many requests" });
    } finally {
      await stop();
    }
  });

  test("a spoofed X-Forwarded-For does not buy fresh rate-limit buckets", async () => {
    const { base, stop } = await boot({ loginStartPerMin: 2 });
    const spoofed = (ip: string) =>
      fetch(`${base}/api/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "nobody@cmr" }),
      });
    try {
      // a different claimed address every time; without a trusted proxy
      // the header is just client input and must not be believed
      expect((await spoofed("10.0.0.1")).status).toBe(401);
      expect((await spoofed("10.0.0.2")).status).toBe(401);
      expect((await spoofed("10.0.0.3")).status).toBe(429);
    } finally {
      await stop();
    }
  });

  test("X-Forwarded-For is honoured once a proxy is trusted", async () => {
    const { base, stop } = await boot({ loginStartPerMin: 2, trustProxyHeader: true });
    const viaProxy = (ip: string) =>
      fetch(`${base}/api/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "nobody@cmr" }),
      });
    try {
      expect((await viaProxy("10.0.0.1")).status).toBe(401);
      expect((await viaProxy("10.0.0.1")).status).toBe(401);
      expect((await viaProxy("10.0.0.1")).status).toBe(429);
      // a genuinely different client still gets its own budget
      expect((await viaProxy("10.0.0.2")).status).toBe(401);
    } finally {
      await stop();
    }
  });

  test("error responses carry CORS headers", async () => {
    const { base, server } = await boot();
    try {
      const res = await fetch(`${base}/api/sites`);
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    } finally {
      server.stop(true);
    }
  });

  test("sites and map require auth and site access", async () => {
    const { post, base, server, stop } = await boot();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const authz = { authorization: `Bearer ${token}` };

      expect((await fetch(`${base}/api/sites`)).status).toBe(401);
      expect(await (await fetch(`${base}/api/sites`, { headers: authz })).json()).toEqual({
        sites: ["coalescent"],
      });

      const map = await fetch(`${base}/api/sites/coalescent/map`, { headers: authz });
      expect(map.status).toBe(200);
      expect(await map.json()).toMatchObject({ name: "coalescent", nodes: [{ id: "a" }] });

      expect((await fetch(`${base}/api/sites/ghost/map`, { headers: authz })).status).toBe(404);
      expect((await fetch(`${base}/api/sites/other/map`, { headers: authz })).status).toBe(403);
    } finally {
      await stop();
    }
  });

  test("streams emit baseline frames with query-token auth", async () => {
    const { post, base, server, contexts, stop } = await boot();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");

      async function firstFrame(path: string): Promise<{ status: number; type: string | null; data: unknown }> {
        const res = await fetch(`${base}${path}?token=${encodeURIComponent(token)}`);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const idx = buf.indexOf("\n\n");
            if (idx >= 0) {
              const match = /^data: (.*)$/s.exec(buf.slice(0, idx));
              return {
                status: res.status,
                type: res.headers.get("content-type"),
                data: match ? JSON.parse(match[1]!) : null,
              };
            }
            if (Date.now() > deadline) throw new Error("timed out waiting for SSE frame");
            const { done, value } = await reader.read();
            if (done) throw new Error("stream closed before first frame");
            buf += decoder.decode(value, { stream: true });
          }
        } finally {
          await reader.cancel();
        }
      }

      const locks = await firstFrame("/api/sites/coalescent/locks/stream");
      expect(locks.status).toBe(200);
      expect(locks.type).toContain("text/event-stream");
      expect(locks.data).toMatchObject({ nodeLocks: [{ id: "a", owners: [], waiters: [] }] });

      const orders = await firstFrame("/api/sites/coalescent/orders/stream");
      expect(orders.status).toBe(200);
      expect(orders.data).toEqual([]);

      // a client joining mid-order gets the orders already in flight,
      // not a blank list it would have to wait for a push to correct
      const ctx = contexts.get("coalescent")!;
      ctx.fleet
        .dispatch({ manufacturer: "T", serialNumber: "baseline-1" }, [{ nodeId: "a", x: 0, y: 0 }])
        .catch(() => {});
      const deadline = Date.now() + 10_000;
      while (ctx.fleet.activeOrderList().length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const joined = await firstFrame("/api/sites/coalescent/orders/stream");
      expect((joined.data as Array<{ serial: string }>).map((o) => o.serial)).toEqual(["baseline-1"]);

      // no token, unknown site, forbidden site
      expect((await fetch(`${base}/api/sites/coalescent/locks/stream`)).status).toBe(401);
      // an unknown site is still 401 without a token: no enumeration
      expect((await fetch(`${base}/api/sites/ghost/locks/stream`)).status).toBe(401);
      expect(
        (await fetch(`${base}/api/sites/ghost/locks/stream?token=${encodeURIComponent(token)}`)).status,
      ).toBe(404);
      expect(
        (await fetch(`${base}/api/sites/other/locks/stream?token=${encodeURIComponent(token)}`)).status,
      ).toBe(403);
    } finally {
      await stop();
    }
  });

  test("dispatch accepts orders, refuses busy robots", async () => {
    const { post, base, server, contexts } = await boot();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const authz = {
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const order = {
        manufacturer: "RobotCompany",
        serialNumber: "api-1",
        waypoints: [{ nodeId: "a", x: 0, y: 0 }],
      };
      const dispatch = (site: string, body: unknown, headers: Record<string, string> = authz) =>
        fetch(`${base}/api/sites/${site}/orders`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

      expect((await dispatch("coalescent", order)).status).toBe(200);
      // manufacturer is optional and falls back to the configured default
      // grant engages synchronously on assign (no AGV needed)
      const ctx = contexts.get("coalescent")!;
      const deadline = Date.now() + 10_000;
      while (
        !(ctx.locks.snapshot().nodeLocks.find((n) => n.id === "a")?.owners.includes("api-1")) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(ctx.locks.snapshot().nodeLocks.find((n) => n.id === "a")?.owners).toEqual(["api-1"]);

      expect((await dispatch("coalescent", order)).status).toBe(409);
      expect((await dispatch("coalescent", { ...order, waypoints: [] })).status).toBe(400);
      expect((await dispatch("coalescent", { ...order, serialNumber: 42 })).status).toBe(400);
      expect(
        (await dispatch("coalescent", order, { "Content-Type": "application/json" })).status,
      ).toBe(401);
      expect((await dispatch("ghost", order)).status).toBe(404);
      expect((await dispatch("other", order)).status).toBe(403);
      // an unknown site without a token is 401, not 404: no enumeration
      expect(
        (await dispatch("ghost", order, { "Content-Type": "application/json" })).status,
      ).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("locks stream pushes on dispatch", async () => {
    const { post, base, server, contexts, stop } = await boot();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");

      const res = await fetch(`${base}/api/sites/coalescent/locks/stream?token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      async function nextFrame(timeoutMs = 10_000): Promise<unknown> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const match = /^data: (.*)$/s.exec(frame);
            if (match) return JSON.parse(match[1]!);
            continue;
          }
          if (Date.now() > deadline) throw new Error("timed out waiting for SSE frame");
          const { done, value } = await reader.read();
          if (done) throw new Error("stream closed");
          buf += decoder.decode(value, { stream: true });
        }
      }
      try {
        const baseline = (await nextFrame()) as {
          nodeLocks: Array<{ id: string; owners: string[] }>;
        };
        expect(baseline.nodeLocks.find((n) => n.id === "a")?.owners).toEqual([]);

        // No AGV needed: the grant engages synchronously on assign.
        const ctx = contexts.get("coalescent")!;
        const pending = ctx.fleet.dispatch(
          { manufacturer: "T", serialNumber: "push-1" },
          [{ nodeId: "a", x: 0, y: 0 }],
        );
        pending.catch(() => {});
        const pushed = (await nextFrame()) as {
          nodeLocks: Array<{ id: string; owners: string[] }>;
        };
        expect(pushed.nodeLocks.find((n) => n.id === "a")?.owners).toEqual(["push-1"]);
      } finally {
        await reader.cancel();
      }
    } finally {
      await stop();
    }
  });

  test("park assigns the nearest free spot, cancel ends tours", async () => {
    const user = await testUser("http@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-park-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({
        name: "coalescent",
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 10, y: 0 },
        ],
        links: [{ source: "a", destination: "b", bidirectional: true }],
        parking: [
          { id: "p1", x: 1, y: 1, entry: "a" },
          { id: "p2", x: 9, y: 1, entry: "b" },
        ],
      }),
    );
    const { server, port, contexts } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      srp: testSrp,
    });
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, token?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const ctx = contexts.get("coalescent")!;
    const robot = new AgvController(
      { manufacturer: "RobotCompany", serialNumber: "park-1" },
      {
        interfaceName: "coalescent",
        vdaVersion: "2.0.0",
        transport: { brokerUrl: "mqtt://memory" },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 2, initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" } },
    );
    attachMemoryTransport(robot, ctx.hub);
    await robot.start();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const authz = { authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const park = (body: unknown, headers: Record<string, string> = authz) =>
        fetch(`${base}/api/sites/coalescent/park`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      const cancel = (body: unknown) =>
        fetch(`${base}/api/sites/coalescent/orders/cancel`, {
          method: "POST",
          headers: authz,
          body: JSON.stringify(body),
        });

      // unknown robot and bad bodies fail before any driving
      expect((await park({ serialNumber: "ghost" })).status).toBe(404);
      expect((await park({})).status).toBe(400);
      expect((await park({ serialNumber: "park-1" }, { "Content-Type": "application/json" })).status).toBe(401);
      expect((await cancel({ serialNumber: "ghost" })).status).toBe(404);
      expect((await cancel({})).status).toBe(400);

      // an unknown site without a token is 401, not 404: answering 404
      // first would let anyone enumerate site names
      for (const path of ["park", "orders/cancel"]) {
        const res = await fetch(`${base}/api/sites/ghost-site/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serialNumber: "park-1" }),
        });
        expect(res.status).toBe(401);
      }

      // wait for the pose, then a long tour stays in flight for the cancel
      const deadline = Date.now() + 10_000;
      while (!ctx.poses.has("park-1") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const tour = await post(
        "/api/sites/coalescent/orders",
        {
          serialNumber: "park-1",
          waypoints: [
            { nodeId: "a", x: 0, y: 0 },
            { nodeId: "b", x: 10, y: 0 },
            { nodeId: "a", x: 0, y: 0 },
            { nodeId: "b", x: 10, y: 0 },
          ],
        },
        token,
      );
      expect(tour.status).toBe(200);
      expect((await cancel({ serialNumber: "park-1" })).status).toBe(200);
      expect((await cancel({ serialNumber: "park-1" })).status).toBe(404);
      expect(ctx.locks.snapshot().nodeLocks.every((n) => n.owners.length === 0)).toBe(true);

      // cancelled robot parks wherever it stopped
      const parked = await (await park({ serialNumber: "park-1" })).json();
      expect(parked.ok).toBe(true);
      expect(["p1", "p2"]).toContain(parked.spot);
    } finally {
      await robot.stop();
      for (const [, c] of contexts) await c.master.stop();
      server.stop(true);
    }
  }, 90_000);

  test("park-many clears several robots, honors zones, reports failures", async () => {
    const user = await testUser("http@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-park-many-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({
        name: "coalescent",
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 10, y: 0 },
        ],
        links: [{ source: "a", destination: "b", bidirectional: true }],
        parking: [
          { id: "p1", x: 1, y: 1, entry: "a", zone: "w" },
          { id: "p2", x: 2, y: 1, entry: "a", zone: "w" },
          { id: "p3", x: 9, y: 1, entry: "b", zone: "e" },
        ],
      }),
    );
    const { server, port, contexts } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      srp: testSrp,
    });
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, token?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const ctx = contexts.get("coalescent")!;
    const startRobot = async (serial: string, x: number) => {
      const robot = new AgvController(
        { manufacturer: "RobotCompany", serialNumber: serial },
        {
          interfaceName: "coalescent",
          vdaVersion: "2.0.0",
          transport: { brokerUrl: "mqtt://memory" },
          topicObjectValidation: { inbound: false, outbound: false },
        },
        { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
        { vehicleSpeed: 2, initialPosition: { mapId: "local", x, y: 0, theta: 0, lastNodeId: "0" } },
      );
      attachMemoryTransport(robot, ctx.hub);
      await robot.start();
      return robot;
    };
    const r1 = await startRobot("bulk-1", 0);
    const r2 = await startRobot("bulk-2", 10);
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const parkMany = (body: unknown) =>
        post("/api/sites/coalescent/park-many", body, token);

      // bad bodies fail before any driving
      expect((await parkMany({})).status).toBe(400);
      expect((await parkMany({ serialNumbers: [] })).status).toBe(400);
      expect((await parkMany({ serialNumbers: ["bulk-1"], zone: "" })).status).toBe(400);

      const deadline = Date.now() + 10_000;
      while ((!ctx.poses.has("bulk-1") || !ctx.poses.has("bulk-2")) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // both fit the west zone; nearest-first assignment, no double booking
      const zoned = await (await parkMany({ serialNumbers: ["bulk-1", "bulk-2"], zone: "w" })).json();
      expect(zoned).toEqual({
        ok: true,
        parked: [
          { serialNumber: "bulk-1", spot: "p1" },
          { serialNumber: "bulk-2", spot: "p2" },
        ],
        failed: [],
      });

      // one east spot: first come, the ghost never reported, bulk-2 loses
      const east = await (
        await parkMany({ serialNumbers: ["bulk-1", "ghost", "bulk-2"], zone: "e" })
      ).json();
      expect(east).toEqual({
        ok: true,
        parked: [{ serialNumber: "bulk-1", spot: "p3" }],
        failed: [
          { serialNumber: "ghost", error: "no recent pose for robot" },
          { serialNumber: "bulk-2", error: "no free parking spot" },
        ],
      });
    } finally {
      await r1.stop();
      await r2.stop();
      for (const [, c] of contexts) await c.master.stop();
      server.stop(true);
    }
  }, 90_000);

  test("raw state endpoint serves the latest body per robot", async () => {
    const user = await testUser("http@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-raw-state-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({ name: "coalescent", nodes: [{ id: "a", x: 0, y: 0 }], links: [] }),
    );
    const { server, port, contexts } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      srp: testSrp,
    });
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, token?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const ctx = contexts.get("coalescent")!;
    const robot = new AgvController(
      { manufacturer: "RobotCompany", serialNumber: "raw-1" },
      {
        interfaceName: "coalescent",
        vdaVersion: "2.0.0",
        transport: { brokerUrl: "mqtt://memory" },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 2, initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" } },
    );
    attachMemoryTransport(robot, ctx.hub);
    await robot.start();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const get = (serial: string, headers: Record<string, string>) =>
        fetch(`${base}/api/sites/coalescent/robots/${serial}/state`, { headers });
      const authz = { authorization: `Bearer ${token}` };

      expect((await get("ghost", authz)).status).toBe(404);
      expect((await get("raw-1", {})).status).toBe(401);

      const deadline = Date.now() + 10_000;
      while (!ctx.rawStates.has("raw-1") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const res = await get("raw-1", authz);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ manufacturer: "RobotCompany", serialNumber: "raw-1" });
      expect(typeof body.receivedAt).toBe("number");
      expect((body.state as Record<string, unknown>).serialNumber).toBe("raw-1");
    } finally {
      await robot.stop();
      for (const [, c] of contexts) await c.master.stop();
      server.stop(true);
    }
  }, 90_000);

  test("tasks assign the nearest robot and complete with history links", async () => {
    const user = await testUser("http@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-tasks-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({
        name: "coalescent",
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 12, y: 0 },
        ],
        links: [{ source: "a", destination: "b", bidirectional: true }],
      }),
    );
    const { server, port, contexts } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      srp: testSrp,
    });
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, token?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const ctx = contexts.get("coalescent")!;
    const robot = new AgvController(
      { manufacturer: "RobotCompany", serialNumber: "task-1" },
      {
        interfaceName: "coalescent",
        vdaVersion: "2.0.0",
        transport: { brokerUrl: "mqtt://memory" },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 8, initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" } },
    );
    attachMemoryTransport(robot, ctx.hub);
    await robot.start();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const getTasks = async () =>
        (await (
          await fetch(`${base}/api/sites/coalescent/tasks`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as { tasks: Array<{ id: string; status: string; assignee?: string; orderId?: string }> };

      // validation first: unknown nodes 400, unroutable pair 409
      expect((await post("/api/sites/coalescent/tasks", { pickup: "ghost", dropoff: "a" }, token)).status).toBe(400);
      expect((await post("/api/sites/coalescent/tasks", {}, token)).status).toBe(400);

      const deadline = Date.now() + 10_000;
      while (!ctx.poses.has("task-1") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const submitted = await (
        await post("/api/sites/coalescent/tasks", { pickup: "b", dropoff: "a" }, token)
      ).json();
      expect(submitted.ok).toBe(true);

      // queued → assigned → done, linked to the history order
      const doneDeadline = Date.now() + 45_000;
      let done;
      for (;;) {
        const { tasks } = await getTasks();
        done = tasks.find((t) => t.id === submitted.taskId);
        if (done?.status === "done") break;
        if (done?.status === "failed" || Date.now() > doneDeadline) {
          throw new Error(`task did not complete: ${JSON.stringify(done)}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(done.assignee).toBe("task-1");
      expect(typeof done.orderId).toBe("string");
      expect(ctx.fleet.orderHistory().map((h) => h.orderId)).toContain(done.orderId!);

      // withdrawing a finished task is refused; withdrawing a queued one works
      const delDone = await fetch(`${base}/api/sites/coalescent/tasks/${submitted.taskId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delDone.status).toBe(409);
      // keep the robot busy with a long tour so the next task stays queued
      await post(
        "/api/sites/coalescent/orders",
        {
          serialNumber: "task-1",
          waypoints: [
            { nodeId: "a", x: 0, y: 0 },
            { nodeId: "b", x: 12, y: 0 },
            { nodeId: "a", x: 0, y: 0 },
            { nodeId: "b", x: 12, y: 0 },
          ],
        },
        token,
      );
      const queued = await (
        await post("/api/sites/coalescent/tasks", { pickup: "a", dropoff: "b" }, token)
      ).json();
      const delQueued = await fetch(`${base}/api/sites/coalescent/tasks/${queued.taskId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delQueued.status).toBe(200);
      expect((await getTasks()).tasks.map((t) => t.id)).not.toContain(queued.taskId);
    } finally {
      await robot.stop();
      for (const [, c] of contexts) await c.master.stop();
      server.stop(true);
    }
  }, 120_000);

  test("demand bumps accumulate, reset, and stream", async () => {
    const { post, base, stop } = await boot();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const authed = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      const path = "/api/sites/coalescent/demand";

      expect((await authed(path, {})).status).toBe(400);
      expect((await authed(path, { zone: "dock" })).status).toBe(400);
      expect((await authed(path, { zone: "dock", count: -1 })).status).toBe(400);
      expect((await authed(path, { zone: "dock", count: 1.5 })).status).toBe(400);

      // subscribe first: baseline, then one push per bump
      const stream = await fetch(`${base}/api/sites/coalescent/demands/stream?token=${token}`);
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const readData = async (): Promise<unknown> => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const match = /^data: (.*)$/m.exec(frame);
            if (match) return JSON.parse(match[1]!);
            continue;
          }
          if (Date.now() > deadline) throw new Error("timed out waiting for demand frame");
          const { done, value } = await reader.read();
          if (done) throw new Error("demand stream closed");
          buf += decoder.decode(value, { stream: true });
        }
      };
      try {
        expect(await readData()).toEqual([]);
        const bumped = await (await authed(path, { zone: "dock", count: 2 })).json();
        expect(bumped).toMatchObject({ ok: true, zone: "dock", demand: 2 });
        expect(await readData()).toEqual([{ zone: "dock", demand: 2 }]);
        await authed(path, { zone: "bay", count: 1 });
        expect(await readData()).toEqual([
          { zone: "bay", demand: 1 },
          { zone: "dock", demand: 2 },
        ]);
        const reset = await (await authed(path, { zone: "dock", count: 0 })).json();
        expect(reset).toMatchObject({ ok: true, zone: "dock", demand: 0 });
        expect(await readData()).toEqual([
          { zone: "bay", demand: 1 },
          { zone: "dock", demand: 0 },
        ]);
      } finally {
        await reader.cancel();
      }
    } finally {
      await stop();
    }
  });

  test("requests consume demand, attach into dispatchable tasks", async () => {
    const user = await testUser("http@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-requests-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({
        name: "coalescent",
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 12, y: 0 },
          { id: "island", x: 50, y: 50 },
        ],
        links: [{ source: "a", destination: "b", bidirectional: true }],
      }),
    );
    const { server, port, contexts } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      srp: testSrp,
    });
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, token?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const ctx = contexts.get("coalescent")!;
    const robot = new AgvController(
      { manufacturer: "RobotCompany", serialNumber: "req-1" },
      {
        interfaceName: "coalescent",
        vdaVersion: "2.0.0",
        transport: { brokerUrl: "mqtt://memory" },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 8, initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" } },
    );
    attachMemoryTransport(robot, ctx.hub);
    await robot.start();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      const getTasks = async () =>
        (await (
          await fetch(`${base}/api/sites/coalescent/tasks`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as {
          tasks: Array<{ id: string; status: string; pickup?: string; assignee?: string; orderId?: string }>;
        };

      // validation rejects before anything is stored
      expect((await post("/api/sites/coalescent/tasks/request", {}, token)).status).toBe(400);
      expect(
        (await post("/api/sites/coalescent/tasks/request", { dropoff: "ghost" }, token)).status,
      ).toBe(400);
      expect(
        (await post("/api/sites/coalescent/tasks/ghost/pickup", { pickup: "a" }, token)).status,
      ).toBe(404);

      // one unit of dock demand becomes one request, counter decremented
      await post("/api/sites/coalescent/demand", { zone: "dock", count: 1 }, token);
      const requested = await (
        await post("/api/sites/coalescent/tasks/request", { dropoff: "b", zone: "dock" }, token)
      ).json();
      expect(requested.ok).toBe(true);
      expect(ctx.demands).toEqual({ dock: 0 });
      // requested tasks wait: no dispatch without a pickup, even idle robots near
      await new Promise((r) => setTimeout(r, 1000));
      expect(ctx.fleet.activeOrderList()).toEqual([]);
      expect((await getTasks()).tasks.find((t) => t.id === requested.taskId)?.status).toBe("requested");

      // attach validation, then the real pickup dispatches to completion
      const attach = (id: string, body: unknown) =>
        post(`/api/sites/coalescent/tasks/${id}/pickup`, body, token);
      expect((await attach(requested.taskId, {})).status).toBe(400);
      expect((await attach(requested.taskId, { pickup: "ghost" })).status).toBe(400);
      expect((await attach(requested.taskId, { pickup: "island" })).status).toBe(409);
      expect((await attach(requested.taskId, { pickup: "a" })).status).toBe(200);
      expect((await attach(requested.taskId, { pickup: "a" })).status).toBe(409);

      const doneDeadline = Date.now() + 45_000;
      let done;
      for (;;) {
        const { tasks } = await getTasks();
        done = tasks.find((t) => t.id === requested.taskId);
        if (done?.status === "done") break;
        if (done?.status === "failed" || Date.now() > doneDeadline) {
          throw new Error(`requested task did not complete: ${JSON.stringify(done)}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(done).toMatchObject({ assignee: "req-1", pickup: "a" });
      expect(typeof done!.orderId).toBe("string");

      // withdrawing a request returns its demand unit
      await post("/api/sites/coalescent/demand", { zone: "dock", count: 1 }, token);
      const requested2 = await (
        await post("/api/sites/coalescent/tasks/request", { dropoff: "b", zone: "dock" }, token)
      ).json();
      expect(ctx.demands).toEqual({ dock: 0 });
      const del = await fetch(`${base}/api/sites/coalescent/tasks/${requested2.taskId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.status).toBe(200);
      expect(ctx.demands).toEqual({ dock: 1 });
      expect((await getTasks()).tasks.map((t) => t.id)).not.toContain(requested2.taskId);
    } finally {
      await robot.stop();
      for (const [, c] of contexts) await c.master.stop();
      server.stop(true);
    }
  }, 120_000);

  test("poses stream forwards robot state", async () => {
    const { post, base, server, contexts } = await boot();
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");

      const ctx = contexts.get("coalescent")!;
      const robot = new AgvController(
        { manufacturer: "RobotCompany", serialNumber: "pose-1" },
        {
          interfaceName: "coalescent",
          vdaVersion: "2.0.0",
          transport: { brokerUrl: "mqtt://memory" },
          topicObjectValidation: { inbound: false, outbound: false },
        },
        { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
        { vehicleSpeed: 2, initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" } },
      );
      attachMemoryTransport(robot, ctx.hub);
      await robot.start();
      try {
        const res = await fetch(`${base}/api/sites/coalescent/poses/stream?token=${encodeURIComponent(token)}`);
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let pose: { serialNumber?: string; x?: number; y?: number } | null = null;
        try {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const idx = buf.indexOf("\n\n");
            if (idx >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const match = /^data: (.*)$/s.exec(frame);
              if (match) {
                const data = JSON.parse(match[1]!);
                if (data.serialNumber === "pose-1") {
                  pose = data;
                  break;
                }
              }
              continue;
            }
            const { done, value } = await reader.read();
            if (done) throw new Error("stream closed");
            buf += decoder.decode(value, { stream: true });
          }
        } finally {
          await reader.cancel();
        }
        expect(pose?.serialNumber).toBe("pose-1");
        expect(Number.isFinite(pose?.x)).toBe(true);
      } finally {
        await robot.stop();
      }
    } finally {
      server.stop(true);
    }
  });

  test("serves HTTPS when cert and key are given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-tls-"));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    const proc = Bun.spawnSync([
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
    ]);
    if (proc.exitCode !== 0) throw new Error("openssl unavailable for TLS test");
    const user = await testUser("tls@cmr", "s3cret", ["coalescent"]);
    const usersFile = join(dir, "users.json");
    writeFileSync(usersFile, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({ name: "coalescent", nodes: [{ id: "a", x: 0, y: 0 }], links: [] }),
    );
    const { port, stop } = await serve({
      port: 0,
      usersFile,
      sitesDir,
      srp: testSrp,
      tlsCert: cert,
      tlsKey: key,
    });
    try {
      // Per-request, not NODE_TLS_REJECT_UNAUTHORIZED: that is process-wide
      // and would silently disable certificate checking for every test
      // running alongside this one.
      const res = await fetch(`https://localhost:${port}/api/health`, {
        tls: { rejectUnauthorized: false },
      } as RequestInit);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await stop();
    }
  });

  test("a task queued with no robot assigns when one appears", async () => {
    const user = await testUser("http@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-late-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({
        name: "coalescent",
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 12, y: 0 },
        ],
        links: [{ source: "a", destination: "b", bidirectional: true }],
      }),
    );
    const { stop, port, contexts } = await serve({ port: 0, usersFile: file, sitesDir, srp: testSrp });
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, token?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const ctx = contexts.get("coalescent")!;
    let robot: AgvController | undefined;
    try {
      const token = await testLogin(post, "http@cmr", "s3cret");
      // queue the work while the site has no robot at all
      expect((await post("/api/sites/coalescent/tasks", { pickup: "a", dropoff: "b" }, token)).status).toBe(200);
      expect([...ctx.tasks.values()][0]).toMatchObject({ status: "queued" });

      // now one turns up — nothing else happens, no order ends
      robot = new AgvController(
        { manufacturer: "RobotCompany", serialNumber: "late-1" },
        {
          interfaceName: "coalescent",
          vdaVersion: "2.0.0",
          transport: { brokerUrl: "mqtt://memory" },
          topicObjectValidation: { inbound: false, outbound: false },
        },
        { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
        { vehicleSpeed: 8, initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" } },
      );
      attachMemoryTransport(robot, ctx.hub);
      await robot.start();

      const deadline = Date.now() + 15_000;
      while ([...ctx.tasks.values()][0]?.status === "queued" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect([...ctx.tasks.values()][0]).toMatchObject({ assignee: "late-1" });
    } finally {
      if (robot) await robot.stop();
      await stop();
    }
  }, 30_000);
});
