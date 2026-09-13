import { describe, expect, test } from "bun:test";
import { createVerifier, srpClient, srpServer } from "../src/srp.js";

describe("SRP signup/login roundtrip", () => {
  test("correct password verifies on both sides", async () => {
    const username = "dev@cmr";
    const record = await createVerifier(username, "password");
    expect(record.scheme).toBe("srp6a-4096-sha256-v1");

    // login step 1: server ephemeral for stored verifier
    const serverEphemeral = await srpServer.generateEphemeral(record.verifier);

    // login step 2: client proves, server verifies
    const privateKey = await srpClient.derivePrivateKey(record.salt, username, "password");
    const clientEphemeral = srpClient.generateEphemeral();
    const clientSession = await srpClient.deriveSession(
      clientEphemeral.secret,
      serverEphemeral.public,
      record.salt,
      username,
      privateKey,
    );
    const serverSession = await srpServer.deriveSession(
      serverEphemeral.secret,
      clientEphemeral.public,
      record.salt,
      username,
      record.verifier,
      clientSession.proof,
    );

    // client verifies server back — mutual authentication
    await srpClient.verifySession(clientEphemeral.public, clientSession, serverSession.proof);
    expect(serverSession.key).toBe(clientSession.key);
  });

  test("wrong password is rejected", async () => {
    const username = "dev@cmr";
    const record = await createVerifier(username, "password");
    const serverEphemeral = await srpServer.generateEphemeral(record.verifier);
    const badKey = await srpClient.derivePrivateKey(record.salt, username, "wrong");
    const clientEphemeral = srpClient.generateEphemeral();
    const badSession = await srpClient.deriveSession(
      clientEphemeral.secret,
      serverEphemeral.public,
      record.salt,
      username,
      badKey,
    );
    await expect(
      srpServer.deriveSession(
        serverEphemeral.secret,
        clientEphemeral.public,
        record.salt,
        username,
        record.verifier,
        badSession.proof,
      ),
    ).rejects.toThrow();
  });
});
