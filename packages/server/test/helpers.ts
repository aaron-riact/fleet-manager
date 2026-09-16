import { createSrp, createVerifier, TEST_GROUP } from "@fleet-manager/core";
import type { UserRecord } from "@fleet-manager/core";

/** Small-group SRP pair shared by server tests (milliseconds, not seconds). */
export const testSrp = createSrp(TEST_GROUP);

export async function testUser(username: string, password: string, sites: string[]): Promise<UserRecord> {
  const record = await createVerifier(username, password, TEST_GROUP);
  return { username, sites, ...record };
}

type PostFn = (path: string, body: unknown) => Promise<Response>;

/** Full HTTP login dance against a test server. Returns the token. */
export async function testLogin(post: PostFn, username: string, password: string): Promise<string> {
  const { client } = testSrp;
  const step1 = (await (await post("/api/login/start", { username })).json()) as {
    salt: string;
    serverEphemeral: string;
  };
  const privateKey = await client.derivePrivateKey(step1.salt, username, password);
  const ephemeral = client.generateEphemeral();
  const session = await client.deriveSession(
    ephemeral.secret,
    step1.serverEphemeral,
    step1.salt,
    username,
    privateKey,
  );
  const finish = (await (
    await post("/api/login/finish", {
      serverEphemeral: step1.serverEphemeral,
      clientEphemeral: ephemeral.public,
      proof: session.proof,
    })
  ).json()) as { token: string };
  return finish.token;
}
