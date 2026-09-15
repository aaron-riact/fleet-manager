import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../src/sqlite.js";
import { createVerifier } from "@fleet-manager/core";
import { Auth } from "../src/auth.js";

describe("SqliteSessionStore", () => {
  test("roundtrips sessions and single-use challenges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sqlite-"));
    const store = new SqliteSessionStore(join(dir, "sessions.db"));
    try {
      expect(await store.getSession("nope")).toBeUndefined();
      await store.saveSession({ token: "t", username: "u", sites: ["s"], createdAt: 1_000 });
      expect(await store.getSession("t")).toEqual({ token: "t", username: "u", sites: ["s"], createdAt: 1_000 });
      await store.deleteSession("t");
      expect(await store.getSession("t")).toBeUndefined();

      await store.saveChallenge("eph", { username: "u", secret: "s", createdAt: 1_000 });
      expect(await store.takeChallenge("eph")).toEqual({ username: "u", secret: "s", createdAt: 1_000 });
      expect(await store.takeChallenge("eph")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  test("purge evicts only expired rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sqlite-"));
    const store = new SqliteSessionStore(join(dir, "sessions.db"));
    try {
      await store.saveSession({ token: "old", username: "u", sites: [], createdAt: 1_000 });
      await store.saveSession({ token: "new", username: "u", sites: [], createdAt: 190_000 });
      expect(await store.purgeExpired(200_000, 60_000, 60_000)).toEqual({ challenges: 0, sessions: 1 });
      expect(await store.getSession("new")).toBeDefined();
    } finally {
      await store.close();
    }
  });

  test("full login survives a store reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sqlite-"));
    const path = join(dir, "sessions.db");
    const record = await createVerifier("alice@cmr", "s3cret");
    const users = [{ username: "alice@cmr", sites: ["coalescent"], ...record }];
    const { srpClient } = await import("@fleet-manager/core");

    const store1 = new SqliteSessionStore(path);
    const auth1 = new Auth(users, { store: store1 });
    const { salt, serverEphemeral } = await auth1.start("alice@cmr");
    const key = await srpClient.derivePrivateKey(salt, "alice@cmr", "s3cret");
    const eph = srpClient.generateEphemeral();
    const sess = await srpClient.deriveSession(eph.secret, serverEphemeral, salt, "alice@cmr", key);
    const { token } = await auth1.finish({ serverEphemeral, clientEphemeral: eph.public, proof: sess.proof });
    await store1.close();

    const store2 = new SqliteSessionStore(path);
    try {
      const auth2 = new Auth(users, { store: store2 });
      expect(await auth2.me(token)).toEqual({ username: "alice@cmr", sites: ["coalescent"] });
    } finally {
      await store2.close();
    }
  });

  test("stores a digest, never the bearer token itself", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "fleet-sql-")), "s.db");
    const store = new SqliteSessionStore(file);
    try {
      const token = "super-secret-bearer-token";
      await store.saveSession({ token, username: "u", sites: ["s"], createdAt: 1 });
      // round-trips by presenting the token
      expect((await store.getSession(token))?.username).toBe("u");
      // but the file never contains it
      const raw = readFileSync(file).toString("binary");
      expect(raw).not.toContain(token);
      await store.deleteSession(token);
      expect(await store.getSession(token)).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  test("a challenge can only be taken once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "fleet-sql-")), "s.db");
    const store = new SqliteSessionStore(file);
    try {
      await store.saveChallenge("eph-1", { username: "u", secret: "sec", createdAt: 1 });
      const both = await Promise.all([store.takeChallenge("eph-1"), store.takeChallenge("eph-1")]);
      expect(both.filter((c) => c !== undefined)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});
