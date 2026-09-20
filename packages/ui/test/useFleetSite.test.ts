import { describe, expect, test } from "bun:test";
import { resolveSiteName } from "../src/useFleetSite.js";

describe("resolveSiteName", () => {
  test("prefers the stored site, falls back to first, null when empty", () => {
    expect(resolveSiteName(["coalescent", "demo"], "demo")).toBe("demo");
    expect(resolveSiteName(["coalescent", "demo"], null)).toBe("coalescent");
    // stale stored name (access revoked, site renamed): first, never an error
    expect(resolveSiteName(["coalescent"], "demo")).toBe("coalescent");
    expect(resolveSiteName([], "demo")).toBeNull();
    expect(resolveSiteName([], null)).toBeNull();
  });
});
