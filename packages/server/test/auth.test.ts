import { describe, expect, test } from "bun:test";
import { createSrp, createVerifier, TEST_GROUP } from "@fleet-manager/core";
import { Auth } from "../src/auth.js";
import type { AuthOptions } from "../src/auth.js";
import { MemorySessionStore } from "../src/sessions.js";

const pair = createSrp(TEST_GROUP);
const { client } = pair;

async function setup() {
  const record = await createVerifier("alice@cmr", "s3cret", TEST_GROUP);
  const users = [{ username: "alice@cmr", sites: ["coalescent"], ...record }];
  return { users };
}

function testAuth(users: { username: string; sites: string[]; scheme: string; salt: string; verifier: string }[], options: Omit<AuthOptions, "srp"> = {}) {
  return new Auth(users, { ...options, srp: pair });
}

async function login(auth: Auth, username: string, password: string) {
  const { salt, serverEphemeral } = await auth.start(username);
  const privateKey = await client.derivePrivateKey(salt, username, password);
  const ephemeral = client.generateEphemeral();
  const session = await client.deriveSession(ephemeral.secret, serverEphemeral, salt, username, privateKey);
  return auth.finish({ serverEphemeral, clientEphemeral: ephemeral.public, proof: session.proof });
}

describe("Auth", () => {
  test("full login issues a usable token", async () => {
    const { users } = await setup();
    const auth = testAuth(users);
    const result = await login(auth, "alice@cmr", "s3cret");
    expect(result.username).toBe("alice@cmr");
    expect(result.sites).toEqual(["coalescent"]);
    expect(await auth.me(result.token)).toEqual({ username: "alice@cmr", sites: ["coalescent"] });
  });

  test("finish returns the server proof for mutual auth", async () => {
    const { users } = await setup();
    const auth = testAuth(users);
    const { salt, serverEphemeral } = await auth.start("alice@cmr");
    const privateKey = await client.derivePrivateKey(salt, "alice@cmr", "s3cret");
    const ephemeral = client.generateEphemeral();
    const clientSession = await client.deriveSession(
      ephemeral.secret, serverEphemeral, salt, "alice@cmr", privateKey,
    );
    const result = await auth.finish({
      serverEphemeral, clientEphemeral: ephemeral.public, proof: clientSession.proof,
    });
    expect(typeof result.proof).toBe("string");
    await client.verifySession(ephemeral.public, clientSession, result.proof);
  });

  test("unknown user and wrong password fail", async () => {
    const { users } = await setup();
    const auth = testAuth(users);
    await expect(auth.start("nobody@cmr")).rejects.toThrow(/unknown user/);
    await expect(login(auth, "alice@cmr", "wrong")).rejects.toThrow();
  });

  test("challenge is single-use and expires", async () => {
    const { users } = await setup();
    let now = 1_000;
    const auth = testAuth(users, { now: () => now, pendingTtlMs: 60_000 });
    const { serverEphemeral } = await auth.start("alice@cmr");
    now += 61_000;
    await expect(
      auth.finish({ serverEphemeral, clientEphemeral: "x", proof: "y" }),
    ).rejects.toThrow(/expired/);
  });

  test("logout invalidates the token", async () => {
    const { users } = await setup();
    const auth = testAuth(users);
    const result = await login(auth, "alice@cmr", "s3cret");
    await auth.logout(result.token);
    await expect(auth.me(result.token)).rejects.toThrow(/invalid session/);
  });

  test("a session answers to the users file of the running server", async () => {
    // Sessions outlive a restart (SESSIONS_FILE), and me() used to trust
    // the stored row: a user removed from users.json, or moved off a site,
    // kept the old access until the TTL ran out.
    const { users } = await setup();
    const store = new MemorySessionStore();
    const alice = users[0]!;
    const before = testAuth([{ ...alice, sites: ["coalescent", "other"] }], { store });
    const { token } = await login(before, "alice@cmr", "s3cret");

    const narrowed = testAuth([alice], { store });
    expect(await narrowed.me(token)).toEqual({ username: "alice@cmr", sites: ["coalescent"] });

    const removed = testAuth([], { store });
    await expect(removed.me(token)).rejects.toMatchObject({ status: 401 });
    // The row is gone, not just refused: re-adding the user needs a new login.
    expect(await store.getSession(token)).toBeUndefined();
  });

  test("sessions expire after sessionTtlMs", async () => {
    const { users } = await setup();
    let now = 1_000;
    const auth = testAuth(users, { now: () => now, sessionTtlMs: 60_000 });
    const result = await login(auth, "alice@cmr", "s3cret");
    expect(await auth.me(result.token)).toEqual({ username: "alice@cmr", sites: ["coalescent"] });
    now += 61_000;
    await expect(auth.me(result.token)).rejects.toThrow(/expired/);
  });

  test("purge evicts expired challenges and sessions", async () => {
    const { users } = await setup();
    let now = 1_000;
    const auth = testAuth(users, { now: () => now, pendingTtlMs: 60_000, sessionTtlMs: 60_000 });
    await auth.start("alice@cmr");
    const result = await login(auth, "alice@cmr", "s3cret");
    now += 61_000;
    expect(await auth.purge()).toEqual({ challenges: 1, sessions: 1 });
    await expect(auth.me(result.token)).rejects.toThrow(/invalid session/);
  });

  test("challenge spray is capped", async () => {
    const { users } = await setup();
    const auth = testAuth(users, { maxPendingChallenges: 1 });
    await auth.start("alice@cmr");
    await expect(auth.start("alice@cmr")).rejects.toThrow(/too many pending/);
  });

  test("expired challenges do not hold the cap shut", async () => {
    const { users } = await setup();
    let now = 1_000;
    const auth = testAuth(users, {
      now: () => now,
      pendingTtlMs: 60_000,
      maxPendingChallenges: 2,
    });
    // two abandoned logins fill the cap
    await auth.start("alice@cmr");
    await auth.start("alice@cmr");
    await expect(auth.start("alice@cmr")).rejects.toThrow(/too many pending/);
    // once they expire the cap must free up, without a restart — the
    // boot purge was the only thing clearing them before
    now += 61_000;
    await auth.start("alice@cmr");
    const result = await login(auth, "alice@cmr", "s3cret");
    expect((await auth.me(result.token)).username).toBe("alice@cmr");
  });

  test("a verifier from another SRP group is refused at construction", async () => {
    const { users } = await setup();
    // a record enrolled at test strength must not quietly load into a
    // server running production parameters
    const weak = [{ ...users[0]!, scheme: "srp6a-1024-sha256-v1" }];
    expect(() => new Auth(weak)).toThrow(/runs srp6a-4096-sha256-v1/);
  });
});
