import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifier, serializeUsersFile, srpClient } from "@fleet-manager/core";
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
  const { server, port } = await serve({ port: 0, usersFile: file, sitesDir });
  const base = `http://localhost:${port}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    return { base, post, server };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

describe("HTTP API", () => {
  test("health, login, me, logout", async () => {
    const { post, base, server } = await boot();
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
      server.stop(true);
    }
  });

  test("unknown user and bad bodies are rejected", async () => {
    const { post, server } = await boot();
    try {
      expect((await post("/api/login/start", { username: "nobody@cmr" })).status).toBe(401);
      expect((await post("/api/login/start", {})).status).toBe(400);
      expect((await post("/api/login/finish", { proof: "x" })).status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("sites and map require auth and site access", async () => {
    const { post, base, server } = await boot();
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
      server.stop(true);
    }
  });
});
