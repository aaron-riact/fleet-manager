import { describe, expect, test } from "bun:test";
import { createSrp, createVerifier, TEST_GROUP } from "@fleet-manager/core";
import { Auth } from "@fleet-manager/server";
import { login } from "../src/authClient.js";

/** fetch stub routing start/finish to a real server Auth instance. */
function stubbedFetch(auth: Auth): typeof fetch {
  return (async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      username: string;
      serverEphemeral: string;
      clientEphemeral: string;
      proof: string;
    };
    if (url.endsWith("/api/login/start")) {
      return Response.json(await auth.start(body.username));
    }
    return Response.json(await auth.finish(body));
  }) as unknown as typeof fetch;
}

describe("authClient", () => {
  const pair = createSrp(TEST_GROUP);
  async function testAuth() {
    const record = await createVerifier("ui@cmr", "s3cret", TEST_GROUP);
    return new Auth([{ username: "ui@cmr", sites: ["coalescent"], ...record }], { srp: pair });
  }

  test("full mutual-auth login against a real Auth backend", async () => {
    const auth = await testAuth();
    const session = await login("http://x", "ui@cmr", "s3cret", stubbedFetch(auth), pair.client);
    expect(session).toMatchObject({ username: "ui@cmr", sites: ["coalescent"] });
    expect(typeof session.token).toBe("string");
    expect(await auth.me(session.token)).toEqual({ username: "ui@cmr", sites: ["coalescent"] });
  });

  test("wrong password fails", async () => {
    const auth = await testAuth();
    await expect(login("http://x", "ui@cmr", "wrong", stubbedFetch(auth), pair.client)).rejects.toThrow();
  });

  test("surfaces server errors", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: "unknown user" }), { status: 401 })) as unknown as typeof fetch;
    await expect(login("http://x", "nobody@cmr", "x", failing)).rejects.toThrow(/unknown user/);
  });
});
