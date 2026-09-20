import { describe, expect, test } from "bun:test";
import { hashFor, parseHash } from "../src/routes.js";

describe("hash routes", () => {
  test("mobile tabs parse, everything else is the desktop shell", () => {
    expect(parseHash("#/m/map")).toEqual({ shell: "mobile", tab: "map", site: null });
    expect(parseHash("#/m/tasks")).toEqual({ shell: "mobile", tab: "tasks", site: null });
    expect(parseHash("#/m/robots")).toEqual({ shell: "mobile", tab: "robots", site: null });
    expect(parseHash("#/m/tools")).toEqual({ shell: "mobile", tab: "tools", site: null });
    expect(parseHash("")).toEqual({ shell: "desktop", tab: "map", site: null });
    expect(parseHash("#/")).toEqual({ shell: "desktop", tab: "map", site: null });
    expect(parseHash("#/m/nope")).toEqual({ shell: "desktop", tab: "map", site: null });
    expect(parseHash("#/m/map/extra/deep")).toEqual({ shell: "desktop", tab: "map", site: null });
  });

  test("site rides along as a query param on either shell", () => {
    expect(parseHash("#/?site=coalescent")).toEqual({ shell: "desktop", tab: "map", site: "coalescent" });
    expect(parseHash("#/m/tasks?site=demo")).toEqual({ shell: "mobile", tab: "tasks", site: "demo" });
    expect(parseHash("#/m/map?site=")).toEqual({ shell: "mobile", tab: "map", site: null });
    expect(parseHash("#/?site=a%20b")).toEqual({ shell: "desktop", tab: "map", site: "a b" });
  });

  test("legacy demo site hashes still parse", () => {
    expect(parseHash("#/site=coalescent")).toEqual({ shell: "desktop", tab: "map", site: "coalescent" });
  });

  test("hashFor round-trips", () => {
    expect(hashFor({ shell: "mobile", tab: "tasks", site: null })).toBe("#/m/tasks");
    expect(hashFor({ shell: "desktop", tab: "map", site: null })).toBe("#/");
    expect(hashFor({ shell: "mobile", tab: "robots", site: "demo" })).toBe("#/m/robots?site=demo");
    expect(hashFor({ shell: "desktop", tab: "map", site: "coalescent" })).toBe("#/?site=coalescent");
    expect(parseHash(hashFor({ shell: "mobile", tab: "robots", site: "demo" }))).toEqual({
      shell: "mobile",
      tab: "robots",
      site: "demo",
    });
  });
});
