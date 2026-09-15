import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgvController, VirtualAgvAdapter } from "vda-5050-lib";
import { createVerifier, serializeUsersFile, srpClient } from "@fleet-manager/core";
import { attachMemoryTransport } from "@fleet-manager/vda";
import { serve } from "../src/serve.js";

async function boot() {
  const record = await createVerifier("http@cmr", "s3cret");
  const dir = mkdtempSync(join(tmpdir(), "fleet-srv-"));
  const file = join(dir, "users.json");
  writeFileSync(file, serializeUsersFile([{ username: "http@cmr", sites: ["coalescent"], ...record }]));
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
  const { server, port, contexts, stop } = await serve({ port: 0, usersFile: file, sitesDir });
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
      const key = await srpClient.derivePrivateKey(step1.salt, "http@cmr", "s3cret");
      const eph = srpClient.generateEphemeral();
      const sess = await srpClient.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "http@cmr", key);
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
      const step1 = await (await post("/api/login/start", { username: "http@cmr" })).json();
      const key = await srpClient.derivePrivateKey(step1.salt, "http@cmr", "s3cret");
      const eph = srpClient.generateEphemeral();
      const sess = await srpClient.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "http@cmr", key);
      const { token } = await (
        await post("/api/login/finish", {
          serverEphemeral: step1.serverEphemeral,
          clientEphemeral: eph.public,
          proof: sess.proof,
        })
      ).json();
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
      const step1 = await (await post("/api/login/start", { username: "http@cmr" })).json();
      const key = await srpClient.derivePrivateKey(step1.salt, "http@cmr", "s3cret");
      const eph = srpClient.generateEphemeral();
      const sess = await srpClient.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "http@cmr", key);
      const { token } = await (
        await post("/api/login/finish", {
          serverEphemeral: step1.serverEphemeral,
          clientEphemeral: eph.public,
          proof: sess.proof,
        })
      ).json();

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
      const step1 = await (await post("/api/login/start", { username: "http@cmr" })).json();
      const key = await srpClient.derivePrivateKey(step1.salt, "http@cmr", "s3cret");
      const eph = srpClient.generateEphemeral();
      const sess = await srpClient.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "http@cmr", key);
      const { token } = await (
        await post("/api/login/finish", {
          serverEphemeral: step1.serverEphemeral,
          clientEphemeral: eph.public,
          proof: sess.proof,
        })
      ).json();
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
      const step1 = await (await post("/api/login/start", { username: "http@cmr" })).json();
      const key = await srpClient.derivePrivateKey(step1.salt, "http@cmr", "s3cret");
      const eph = srpClient.generateEphemeral();
      const sess = await srpClient.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "http@cmr", key);
      const { token } = await (
        await post("/api/login/finish", {
          serverEphemeral: step1.serverEphemeral,
          clientEphemeral: eph.public,
          proof: sess.proof,
        })
      ).json();

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

  test("poses stream forwards robot state", async () => {
    const { post, base, server, contexts } = await boot();
    try {
      const step1 = await (await post("/api/login/start", { username: "http@cmr" })).json();
      const key = await srpClient.derivePrivateKey(step1.salt, "http@cmr", "s3cret");
      const eph = srpClient.generateEphemeral();
      const sess = await srpClient.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "http@cmr", key);
      const { token } = await (
        await post("/api/login/finish", {
          serverEphemeral: step1.serverEphemeral,
          clientEphemeral: eph.public,
          proof: sess.proof,
        })
      ).json();

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
});
