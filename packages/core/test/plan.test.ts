import { describe, expect, test } from "bun:test";
import { nearestNode, parkRoute, shortestPath } from "../src/plan.js";
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

describe("nearestNode", () => {
  test("finds the closest graph node to a free coordinate", () => {
    expect(nearestNode(site, 0.2, 0.1)).toBe("a");
    expect(nearestNode(site, 9.9, 0.1)).toBe("c");
    // d sits at (5,6): closest to the midpoint below it
    expect(nearestNode(site, 5, 2)).toBe("b");
  });
});

describe("parkRoute", () => {
  test("routes from the robot to the spot entry over the network", () => {
    const route = parkRoute(site, { x: 0, y: 0 }, { id: "p1", x: 10, y: 1, entry: "c" });
    expect(route?.map((w) => w.nodeId)).toEqual(["a", "b", "c"]);
    expect(route?.[2]).toMatchObject({ nodeId: "c", x: 10, y: 0 });
  });

  test("falls back to the nearest node without an entry", () => {
    const route = parkRoute(site, { x: 0, y: 0 }, { id: "p1", x: 10, y: 1 });
    expect(route?.map((w) => w.nodeId)).toEqual(["a", "b", "c"]);
  });

  test("returns undefined when unreachable", () => {
    expect(parkRoute(site, { x: 0, y: 0 }, { id: "p1", x: 50, y: 50, entry: "island" })).toBeUndefined();
  });
});
