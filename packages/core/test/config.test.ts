import { describe, expect, test } from "bun:test";
import { parseUsersFile, serializeUsersFile } from "../src/config.js";
import type { UserRecord } from "../src/config.js";

const alice: UserRecord = {
  username: "alice@cmr",
  sites: ["coalescent"],
  scheme: "srp6a-4096-sha256-v1",
  salt: "abc123",
  verifier: "def456",
};

describe("users.json config", () => {
  test("valid file parses", () => {
    expect(parseUsersFile(JSON.stringify({ users: [alice] }))).toEqual([alice]);
  });

  test("rejects wrong scheme, missing salt, empty sites", () => {
    expect(() =>
      parseUsersFile(JSON.stringify({ users: [{ ...alice, scheme: "sha1-v1" }] })),
    ).toThrow();
    expect(() =>
      parseUsersFile(JSON.stringify({ users: [{ ...alice, salt: undefined }] })),
    ).toThrow();
    expect(() => parseUsersFile(JSON.stringify({ users: [{ ...alice, sites: [] }] }))).toThrow();
    expect(() => parseUsersFile(JSON.stringify({ users: [{ ...alice, username: "" }] }))).toThrow();
  });

  test("rejects malformed JSON and wrong shape", () => {
    expect(() => parseUsersFile("{nope")).toThrow(/not valid JSON/);
    expect(() => parseUsersFile(JSON.stringify({ users: [alice, 42] }))).toThrow();
  });

  test("serialize/parse roundtrip is stable and sorted", () => {
    const bob: UserRecord = { ...alice, username: "bob@cmr", sites: ["b", "a"] };
    const text = serializeUsersFile([bob, alice]);
    expect(parseUsersFile(text).map((u) => u.username)).toEqual(["alice@cmr", "bob@cmr"]);
    expect(parseUsersFile(text)[1]?.sites).toEqual(["a", "b"]);
    expect(text.endsWith("\n")).toBe(true);
  });
});
