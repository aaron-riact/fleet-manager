import { readFileSync, writeFileSync } from "node:fs";
import { parseUsersFile, serializeUsersFile } from "@fleet-manager/core";
import type { UserRecord } from "@fleet-manager/core";

/** Read + validate a users.json file (server/CLI side; core stays I/O-free). */
export async function loadUsersFile(path: string): Promise<UserRecord[]> {
  const { readFile } = await import("node:fs/promises");
  return parseUsersFile(await readFile(path, "utf8"));
}

export function loadUsersFileSync(path: string): UserRecord[] {
  return parseUsersFile(readFileSync(path, "utf8"));
}

export function saveUsersFileSync(path: string, users: UserRecord[]): void {
  writeFileSync(path, serializeUsersFile(users));
}
