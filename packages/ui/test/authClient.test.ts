import { describe, expect, test } from "bun:test";
import { createVerifier } from "@fleet-manager/core";
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
  test("full mutual-auth login against a real Auth backend", async () => {
    const record = await createVerifier("ui@cmr", "s3cret");
    const auth = new Auth([{ username: "ui@cmr", sites: ["coalescent"], ...record }]);
    const session = await login("http://x", "ui@cmr", "s3cret", stubbedFetch(auth));
    expect(session).toMatchObject({ username: "ui@cmr", sites: ["coalescent"] });
    expect(typeof session.token).toBe("string");
    expect(await auth.me(session.token)).toEqual({ username: "ui@cmr", sites: ["coalescent"] });
  });

  test("wrong password fails", async () => {
    const record = await createVerifier("ui@cmr", "s3cret");
    const auth = new Auth([{ username: "ui@cmr", sites: ["coalescent"], ...record }]);
    await expect(login("http://x", "ui@cmr", "wrong", stubbedFetch(auth))).rejects.toThrow();
  });

  test("surfaces server errors", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: "unknown user" }), { status: 401 })) as unknown as typeof fetch;
    await expect(login("http://x", "nobody@cmr", "x", failing)).rejects.toThrow(/unknown user/);
  });
});
