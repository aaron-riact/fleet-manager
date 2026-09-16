import { createSRPClient, createSRPServer } from "js-srp6a";
import type { PrimeGroup } from "js-srp6a";

export type { PrimeGroup };

/**
 * Standard SRP-6a parameters for fleet-manager. Deliberately the library
 * defaults with nothing custom layered on top: the private key KDF is
 * js-srp6a's own, so any standard client can reproduce a verifier.
 * (fm-vda5050's bespoke PBKDF2 wrapper is the cautionary tale.)
 */
export const SRP_HASH = "SHA-256" as const;
export const SRP_GROUP = 4096 as const;
export const SRP_SCHEME = "srp6a-4096-sha256-v1" as const;

/** Test-size group. Same protocol, milliseconds instead of seconds. */
export const TEST_GROUP = 1024 as const;

export interface SrpPair {
  /** Prime group these two were built for; records must match it. */
  group: PrimeGroup;
  client: ReturnType<typeof createSRPClient>;
  server: ReturnType<typeof createSRPServer>;
}

/** Scheme tag stored in users.json for a given group. */
export function schemeFor(group: PrimeGroup): string {
  return `srp6a-${group}-sha256-v1`;
}

/** Matched client/server pair. Production always uses the defaults. */
export function createSrp(group: PrimeGroup = SRP_GROUP): SrpPair {
  return {
    group,
    client: createSRPClient(SRP_HASH, group),
    server: createSRPServer(SRP_HASH, group),
  };
}

export const srpClient = createSrp().client;
export const srpServer = createSrp().server;

export interface VerifierRecord {
  scheme: string;
  salt: string;
  verifier: string;
}

/** Create a storable verifier (CLI / signup path). */
export async function createVerifier(
  username: string,
  password: string,
  group: PrimeGroup = SRP_GROUP,
): Promise<VerifierRecord> {
  const { client } = createSrp(group);
  const salt = client.generateSalt();
  const privateKey = await client.derivePrivateKey(salt, username, password);
  const verifier = client.deriveVerifier(privateKey);
  return { scheme: schemeFor(group), salt, verifier };
}
