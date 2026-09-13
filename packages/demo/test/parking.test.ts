import { describe, expect, test } from "bun:test";
import { freeEntry, freeSpot } from "../src/parking.js";

const spots = [
  { id: "p1", x: 0, y: 0 },
  { id: "p2", x: 10, y: 0 },
];

describe("freeSpot", () => {
  test("nearest free spot wins", () => {
    expect(freeSpot(spots, new Map(), { x: 9, y: 1 })?.id).toBe("p2");
    expect(freeSpot(spots, new Map([["p2", "r1"]]), { x: 9, y: 1 })?.id).toBe("p1");
  });

  test("none free, or no position", () => {
    expect(freeSpot(spots, new Map([["p1", "a"], ["p2", "b"]]))).toBeUndefined();
    expect(freeSpot(spots, {})?.id).toBe("p1");
    expect(freeSpot([], new Map())?.id).toBeUndefined();
  });
});

describe("freeEntry", () => {
  const nodes = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
  ];
  const snap = (owners: Record<string, string[]>) => ({
    nodeLocks: nodes.map((n) => ({ id: n.id, owners: owners[n.id] ?? [], waiters: [] as string[] })),
    edgeLocks: [],
  });

  test("nearest unowned node wins", () => {
    expect(freeEntry(nodes, snap({}), { x: 9, y: 1 })?.id).toBe("b");
    expect(freeEntry(nodes, snap({ b: ["r1"] }), { x: 9, y: 1 })?.id).toBe("a");
  });

  test("undefined when everything is owned", () => {
    expect(freeEntry(nodes, snap({ a: ["r1"], b: ["r2"] }), { x: 0, y: 0 })).toBeUndefined();
  });
});
