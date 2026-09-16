import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createVerifier, parseUsersFile, serializeUsersFile } from "@fleet-manager/core";
import type { PrimeGroup, UserRecord } from "@fleet-manager/core";

export interface AddUserInput {
  username: string;
  password: string;
  sites: string[];
}

/** Load users.json; missing file means an empty user list. */
export function loadUsers(path: string): UserRecord[] {
  if (!existsSync(path)) return [];
  return parseUsersFile(readFileSync(path, "utf8"));
}

export function saveUsers(path: string, users: UserRecord[]): void {
  writeFileSync(path, serializeUsersFile(users));
}

/** Add a user (throws on duplicates or empty secrets). Returns the new list. */
export async function addUser(
  existing: UserRecord[],
  input: AddUserInput,
  group?: PrimeGroup,
): Promise<UserRecord[]> {
  const username = input.username.trim();
  if (!username) throw new Error("username must not be empty");
  if (!input.password) throw new Error("password must not be empty");
  const sites = input.sites.map((s) => s.trim()).filter(Boolean);
  if (sites.length === 0) throw new Error("at least one site is required");
  if (existing.some((u) => u.username === username)) {
    throw new Error(`user already exists: "${username}"`);
  }
  const { scheme, salt, verifier } = await createVerifier(username, input.password, group);
  return [...existing, { username, sites, scheme, salt, verifier }];
}
