import { describe, expect, test } from "bun:test";
import { adoptPinnedSite, resolveSiteName } from "../src/useFleetSite.js";

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

describe("adoptPinnedSite", () => {
  test("a changed pin wins: Back and Forward pull the view along", () => {
    expect(adoptPinnedSite("demo", "coalescent")).toEqual({ adopt: true, site: "demo" });
    expect(adoptPinnedSite("demo", undefined)).toEqual({ adopt: true, site: "demo" });
  });

  test("an unchanged pin leaves the user's own pick alone", () => {
    // The pin is re-read every render, so this is the common case: the
    // shell must not drag the view back to the pinned site each time.
    expect(adoptPinnedSite("demo", "demo")).toEqual({ adopt: false });
  });

  test("no pin at all means the hook keeps deciding", () => {
    expect(adoptPinnedSite(undefined, undefined)).toEqual({ adopt: false });
    expect(adoptPinnedSite(null, "demo")).toEqual({ adopt: false });
  });
});
