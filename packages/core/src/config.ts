import { z } from "zod";
import { SRP_SCHEME } from "./srp.js";

/**
 * users.json — the user database. Plain JSON, validated at load.
 * No build step, no clipboard ritual: `fleet users add` writes it.
 */
export const UserRecordSchema = z.object({
  username: z.string().min(1),
  sites: z.array(z.string().min(1)).min(1),
  scheme: z.literal(SRP_SCHEME),
  salt: z.string().min(1),
  verifier: z.string().min(1),
});

export type UserRecord = z.infer<typeof UserRecordSchema>;

const UsersFileSchema = z.object({
  users: z.array(UserRecordSchema),
});

/** Parse users.json text. Pure (no I/O) so it runs in any runtime. */
export function parseUsersFile(text: string): UserRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`users.json is not valid JSON: ${(error as Error).message}`);
  }
  return UsersFileSchema.parse(json).users;
}

/** Serialize users back to users.json format (stable key order, 2-space). */
export function serializeUsersFile(users: UserRecord[]): string {
  const ordered = [...users]
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(({ username, sites, scheme, salt, verifier }) => ({
      username,
      sites: [...sites].sort(),
      scheme,
      salt,
      verifier,
    }));
  return JSON.stringify({ users: ordered }, null, 2) + "\n";
}
