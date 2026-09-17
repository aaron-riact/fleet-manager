import { describe, expect, test } from "bun:test";
import { shortestPath } from "../src/plan.js";
import type { Site } from "../src/site.js";

const site: Site = {
  name: "plan",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 5, y: 0 },
    { id: "c", x: 10, y: 0 },
    { id: "d", x: 5, y: 6 },
    { id: "island", x: 50, y: 50 },
  ],
  links: [
    { source: "a", destination: "b", bidirectional: true },
    { source: "b", destination: "c", bidirectional: true },
    // one-way detour via d: longer there, the only way back from d
    { source: "a", destination: "d" },
    { source: "d", destination: "c" },
  ],
};

describe("shortestPath", () => {
  test("prefers the shorter route and honors direction", () => {
    // a-b-c is 10; via d is 2*sqrt(61) — the planner must weigh, not hop-count
    expect(shortestPath(site, "a", "c")).toEqual(["a", "b", "c"]);
    expect(shortestPath(site, "c", "a")).toEqual(["c", "b", "a"]);
    expect(shortestPath(site, "a", "d")).toEqual(["a", "d"]);
    // d has no way back except round the loop
    expect(shortestPath(site, "d", "a")).toEqual(["d", "c", "b", "a"]);
  });

  test("degenerate and unreachable inputs", () => {
    expect(shortestPath(site, "b", "b")).toEqual(["b"]);
    expect(shortestPath(site, "a", "island")).toBeUndefined();
    expect(shortestPath(site, "a", "ghost")).toBeUndefined();
    expect(shortestPath(site, "ghost", "a")).toBeUndefined();
  });
});
