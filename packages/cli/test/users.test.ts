import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_GROUP } from "@fleet-manager/core";
import { addUser, loadUsers, saveUsers } from "../src/users.js";

const fast = TEST_GROUP;

describe("users file ops", () => {
  test("addUser creates a verifiable record", async () => {
    const users = await addUser([], { username: "alice@cmr", password: "s3cret", sites: ["coalescent"] }, fast);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: "alice@cmr", sites: ["coalescent"] });
    expect(users[0]?.scheme).toBe("srp6a-1024-sha256-v1");
  });

  test("addUser rejects duplicates and empty input", async () => {
    const users = await addUser([], { username: "alice@cmr", password: "s3cret", sites: ["coalescent"] }, fast);
    await expect(
      addUser(users, { username: "alice@cmr", password: "other", sites: ["coalescent"] }, fast),
    ).rejects.toThrow(/already exists/);
    await expect(addUser([], { username: " ", password: "x", sites: ["s"] }, fast)).rejects.toThrow();
    await expect(addUser([], { username: "b@cmr", password: "", sites: ["s"] }, fast)).rejects.toThrow();
    await expect(addUser([], { username: "b@cmr", password: "x", sites: [] }, fast)).rejects.toThrow();
  });

  test("load/save roundtrips through disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    const path = join(dir, "users.json");
    expect(loadUsers(path)).toEqual([]);
    const users = await addUser([], { username: "alice@cmr", password: "s3cret", sites: ["coalescent"] }, fast);
    saveUsers(path, users);
    expect(loadUsers(path)).toEqual(users);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("users");
  });
});
