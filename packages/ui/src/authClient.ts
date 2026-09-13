import { srpClient } from "@fleet-manager/core";

export interface LoginSession {
  token: string;
  username: string;
  sites: string[];
}

export type FetchFn = typeof fetch;

/**
 * SRP login against the fleet-manager API. Pure fetch — no DOM —
 * so it runs in browsers, tests, and anywhere else.
 */
export async function login(
  baseUrl: string,
  username: string,
  password: string,
  fetchFn: FetchFn = fetch,
): Promise<LoginSession> {
  const post = async (path: string, body: unknown) => {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `login failed: ${res.status}`);
    return data;
  };

  const step1 = await post("/api/login/start", { username });
  if (typeof step1.salt !== "string" || typeof step1.serverEphemeral !== "string") {
    throw new Error("bad challenge from server");
  }
  const privateKey = await srpClient.derivePrivateKey(step1.salt, username, password);
  const ephemeral = srpClient.generateEphemeral();
  const session = await srpClient.deriveSession(
    ephemeral.secret,
    step1.serverEphemeral,
    step1.salt,
    username,
    privateKey,
  );
  const step2 = await post("/api/login/finish", {
    serverEphemeral: step1.serverEphemeral,
    clientEphemeral: ephemeral.public,
    proof: session.proof,
  });
  if (typeof step2.token !== "string") throw new Error("bad session from server");
  await srpClient.verifySession(ephemeral.public, session, step2.proof as string);
  return {
    token: step2.token,
    username: step2.username as string,
    sites: step2.sites as string[],
  };
}
