import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUser, loadUsers, saveUsers } from "../src/users.js";

describe("users file ops", () => {
  test("addUser creates a verifiable record", async () => {
    const users = await addUser([], { username: "alice@cmr", password: "s3cret", sites: ["coalescent"] });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: "alice@cmr", sites: ["coalescent"] });
    expect(users[0]?.scheme).toBe("srp6a-4096-sha256-v1");
  });

  test("addUser rejects duplicates and empty input", async () => {
    const users = await addUser([], { username: "alice@cmr", password: "s3cret", sites: ["coalescent"] });
    await expect(
      addUser(users, { username: "alice@cmr", password: "other", sites: ["coalescent"] }),
    ).rejects.toThrow(/already exists/);
    await expect(addUser([], { username: " ", password: "x", sites: ["s"] })).rejects.toThrow();
    await expect(addUser([], { username: "b@cmr", password: "", sites: ["s"] })).rejects.toThrow();
    await expect(addUser([], { username: "b@cmr", password: "x", sites: [] })).rejects.toThrow();
  });

  test("load/save roundtrips through disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    const path = join(dir, "users.json");
    expect(loadUsers(path)).toEqual([]);
    const users = await addUser([], { username: "alice@cmr", password: "s3cret", sites: ["coalescent"] });
    saveUsers(path, users);
    expect(loadUsers(path)).toEqual(users);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("users");
  });
});
