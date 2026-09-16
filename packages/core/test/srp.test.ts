import { describe, expect, test } from "bun:test";
import { createSrp, createVerifier, SRP_GROUP, TEST_GROUP } from "../src/srp.js";

const { client, server } = createSrp(TEST_GROUP);

describe("SRP signup/login roundtrip", () => {
  test("production defaults stay at 4096 bits", async () => {
    expect(SRP_GROUP).toBe(4096);
    const record = await createVerifier("dev@cmr", "password");
    expect(record.scheme).toBe("srp6a-4096-sha256-v1");
  });

  test("correct password verifies on both sides", async () => {
    const username = "dev@cmr";
    const record = await createVerifier(username, "password", TEST_GROUP);
    expect(record.scheme).toBe("srp6a-1024-sha256-v1");

    // login step 1: server ephemeral for stored verifier
    const serverEphemeral = await server.generateEphemeral(record.verifier);

    // login step 2: client proves, server verifies
    const privateKey = await client.derivePrivateKey(record.salt, username, "password");
    const clientEphemeral = client.generateEphemeral();
    const clientSession = await client.deriveSession(
      clientEphemeral.secret,
      serverEphemeral.public,
      record.salt,
      username,
      privateKey,
    );
    const serverSession = await server.deriveSession(
      serverEphemeral.secret,
      clientEphemeral.public,
      record.salt,
      username,
      record.verifier,
      clientSession.proof,
    );

    // client verifies server back — mutual authentication
    await client.verifySession(clientEphemeral.public, clientSession, serverSession.proof);
    expect(serverSession.key).toBe(clientSession.key);
  });

  test("wrong password is rejected", async () => {
    const username = "dev@cmr";
    const record = await createVerifier(username, "password", TEST_GROUP);
    const serverEphemeral = await server.generateEphemeral(record.verifier);
    const badKey = await client.derivePrivateKey(record.salt, username, "wrong");
    const clientEphemeral = client.generateEphemeral();
    const badSession = await client.deriveSession(
      clientEphemeral.secret,
      serverEphemeral.public,
      record.salt,
      username,
      badKey,
    );
    await expect(
      server.deriveSession(
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
