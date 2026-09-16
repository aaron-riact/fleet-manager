import { treaty } from "@elysiajs/eden";
import type { FleetApi } from "@fleet-manager/server";
import { srpClient } from "@fleet-manager/core";
import type { SrpPair } from "@fleet-manager/core";
import { errorMessage } from "./api.js";

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
  srp: SrpPair["client"] = srpClient,
): Promise<LoginSession> {
  const api = treaty<FleetApi>(baseUrl, { fetcher: fetchFn as typeof fetch });

  const start = await api.api.login.start.post({ username });
  if (start.data == null || "error" in start.data) {
    throw new Error(
      start.data != null ? start.data.error : errorMessage(start.error, start.status),
    );
  }
  const { salt, serverEphemeral } = start.data;
  const privateKey = await srp.derivePrivateKey(salt, username, password);
  const ephemeral = srp.generateEphemeral();
  const session = await srp.deriveSession(
    ephemeral.secret,
    serverEphemeral,
    salt,
    username,
    privateKey,
  );
  const finish = await api.api.login.finish.post({
    serverEphemeral,
    clientEphemeral: ephemeral.public,
    proof: session.proof,
  });
  if (finish.data == null || "error" in finish.data) {
    throw new Error(
      finish.data != null ? finish.data.error : errorMessage(finish.error, finish.status),
    );
  }
  await srp.verifySession(ephemeral.public, session, finish.data.proof);
  return {
    token: finish.data.token,
    username: finish.data.username,
    sites: finish.data.sites,
  };
}
