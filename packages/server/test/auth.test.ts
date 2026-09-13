import { describe, expect, test } from "bun:test";
import { createVerifier, srpClient } from "@fleet-manager/core";
import { Auth } from "../src/auth.js";

async function setup() {
  const record = await createVerifier("alice@cmr", "s3cret");
  const users = [{ username: "alice@cmr", sites: ["coalescent"], ...record }];
  return { users };
}

async function login(auth: Auth, username: string, password: string) {
  const { salt, serverEphemeral } = await auth.start(username);
  const privateKey = await srpClient.derivePrivateKey(salt, username, password);
  const ephemeral = srpClient.generateEphemeral();
  const session = await srpClient.deriveSession(ephemeral.secret, serverEphemeral, salt, username, privateKey);
  return auth.finish({ serverEphemeral, clientEphemeral: ephemeral.public, proof: session.proof });
}

describe("Auth", () => {
  test("full login issues a usable token", async () => {
    const { users } = await setup();
    const auth = new Auth(users);
    const result = await login(auth, "alice@cmr", "s3cret");
    expect(result.username).toBe("alice@cmr");
    expect(result.sites).toEqual(["coalescent"]);
    expect(auth.me(result.token)).toEqual({ username: "alice@cmr", sites: ["coalescent"] });
  });

  test("finish returns the server proof for mutual auth", async () => {
    const { users } = await setup();
    const auth = new Auth(users);
    const { salt, serverEphemeral } = await auth.start("alice@cmr");
    const privateKey = await srpClient.derivePrivateKey(salt, "alice@cmr", "s3cret");
    const ephemeral = srpClient.generateEphemeral();
    const clientSession = await srpClient.deriveSession(
      ephemeral.secret, serverEphemeral, salt, "alice@cmr", privateKey,
    );
    const result = await auth.finish({
      serverEphemeral, clientEphemeral: ephemeral.public, proof: clientSession.proof,
    });
    expect(typeof result.proof).toBe("string");
    await srpClient.verifySession(ephemeral.public, clientSession, result.proof);
  });

  test("unknown user and wrong password fail", async () => {
    const { users } = await setup();
    const auth = new Auth(users);
    await expect(auth.start("nobody@cmr")).rejects.toThrow(/unknown user/);
    await expect(login(auth, "alice@cmr", "wrong")).rejects.toThrow();
  });

  test("challenge is single-use and expires", async () => {
    const { users } = await setup();
    let now = 1_000;
    const auth = new Auth(users, { now: () => now, pendingTtlMs: 60_000 });
    const { serverEphemeral } = await auth.start("alice@cmr");
    now += 61_000;
    await expect(
      auth.finish({ serverEphemeral, clientEphemeral: "x", proof: "y" }),
    ).rejects.toThrow(/expired/);
  });

  test("logout invalidates the token", async () => {
    const { users } = await setup();
    const auth = new Auth(users);
    const result = await login(auth, "alice@cmr", "s3cret");
    auth.logout(result.token);
    expect(() => auth.me(result.token)).toThrow(/invalid session/);
  });
});
