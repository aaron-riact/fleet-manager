import { createSRPClient, createSRPServer } from "js-srp6a";

/**
 * Standard SRP-6a parameters for fleet-manager. Deliberately the library
 * defaults with nothing custom layered on top: the private key KDF is
 * js-srp6a's own, so any standard client can reproduce a verifier.
 * (fm-vda5050's bespoke PBKDF2 wrapper is the cautionary tale.)
 */
export const SRP_HASH = "SHA-256" as const;
export const SRP_GROUP = 4096 as const;
export const SRP_SCHEME = "srp6a-4096-sha256-v1" as const;

export const srpClient = createSRPClient(SRP_HASH, SRP_GROUP);
export const srpServer = createSRPServer(SRP_HASH, SRP_GROUP);

export interface VerifierRecord {
  scheme: typeof SRP_SCHEME;
  salt: string;
  verifier: string;
}

/** Create a storable verifier (CLI / signup path). */
export async function createVerifier(username: string, password: string): Promise<VerifierRecord> {
  const salt = srpClient.generateSalt();
  const privateKey = await srpClient.derivePrivateKey(salt, username, password);
  const verifier = srpClient.deriveVerifier(privateKey);
  return { scheme: SRP_SCHEME, salt, verifier };
}
