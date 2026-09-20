import { describe, expect, test } from "bun:test";
import { hashFor, parseHash } from "../src/routes.js";

describe("hash routes", () => {
  test("mobile tabs parse, everything else is the desktop shell", () => {
    expect(parseHash("#/m/map")).toEqual({ shell: "mobile", tab: "map" });
    expect(parseHash("#/m/tasks")).toEqual({ shell: "mobile", tab: "tasks" });
    expect(parseHash("#/m/robots")).toEqual({ shell: "mobile", tab: "robots" });
    expect(parseHash("#/m/tools")).toEqual({ shell: "mobile", tab: "tools" });
    expect(parseHash("")).toEqual({ shell: "desktop", tab: "map" });
    expect(parseHash("#/")).toEqual({ shell: "desktop", tab: "map" });
    expect(parseHash("#/m/nope")).toEqual({ shell: "desktop", tab: "map" });
    expect(parseHash("#/m/map/extra/deep")).toEqual({ shell: "desktop", tab: "map" });
  });

  test("hashFor round-trips", () => {
    expect(hashFor({ shell: "mobile", tab: "tasks" })).toBe("#/m/tasks");
    expect(hashFor({ shell: "desktop", tab: "map" })).toBe("#/");
    expect(parseHash(hashFor({ shell: "mobile", tab: "robots" }))).toEqual({
      shell: "mobile",
      tab: "robots",
    });
  });
});
