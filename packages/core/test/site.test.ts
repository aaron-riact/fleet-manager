import { describe, expect, test } from "bun:test";
import { freeSpot, occupiedSpots, parseSite } from "../src/site.js";

const loop = {
  name: "demo-loop",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
    { id: "c", x: 10, y: 8 },
  ],
  links: [
    { source: "a", destination: "b", bidirectional: true },
    { source: "b", destination: "c" },
  ],
};

describe("site schema", () => {
  test("valid site parses", () => {
    expect(parseSite(JSON.stringify(loop)).name).toBe("demo-loop");
  });

  test("optional underlay parses; empty rectangles rejected", () => {
    const underlay = { uri: "maps/hall.png", minX: -5, minY: -2, maxX: 15, maxY: 10 };
    expect(parseSite(JSON.stringify(loop)).underlay).toBeUndefined();
    expect(parseSite(JSON.stringify({ ...loop, underlay })).underlay).toEqual(underlay);
    expect(() =>
      parseSite(JSON.stringify({ ...loop, underlay: { ...underlay, maxX: underlay.minX } })),
    ).toThrow(/non-empty world rectangle/);
    expect(() =>
      parseSite(JSON.stringify({ ...loop, underlay: { ...underlay, uri: "" } })),
    ).toThrow();
  });

  test("rejects dangling links, empty nodes, bad JSON", () => {
    expect(() =>
      parseSite(JSON.stringify({ ...loop, links: [{ source: "a", destination: "ghost" }] })),
    ).toThrow(/known nodes/);
    expect(() => parseSite(JSON.stringify({ ...loop, nodes: [] }))).toThrow();
    expect(() => parseSite("{nope")).toThrow(/not valid JSON/);
    expect(() => parseSite(JSON.stringify({ ...loop, nodes: [{ id: "a", x: NaN, y: 0 }] }))).toThrow();
  });

  test("parking is optional and must not collide with nodes", () => {
    expect(parseSite(JSON.stringify({ ...loop, parking: [{ id: "p1", x: 5, y: 4 }] })).parking).toEqual([
      { id: "p1", x: 5, y: 4 },
    ]);
    expect(parseSite(JSON.stringify(loop)).parking).toBeUndefined();
    expect(() => parseSite(JSON.stringify({ ...loop, parking: [{ id: "a", x: 5, y: 4 }] }))).toThrow();
  });

  test("locations need a pose and a unique id", () => {
    const base = {
      name: "s",
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 5, y: 0 },
      ],
      links: [],
    };
    const good = {
      ...base,
      locations: [
        { id: "dock-1", name: "Dock 1", zone: "docks", pickPose: { x: 0, y: 0 }, dropPose: { x: 5, y: 0 } },
        { id: "bay-1", pickPose: { x: 1, y: 1 } },
      ],
    };
    expect(parseSite(JSON.stringify(good)).locations).toHaveLength(2);
    expect(parseSite(JSON.stringify(base)).locations).toBeUndefined();
    // no poses at all
    expect(() => parseSite(JSON.stringify({ ...base, locations: [{ id: "x" }] }))).toThrow(/pick pose/);
    // collides with a node
    expect(() =>
      parseSite(JSON.stringify({ ...base, locations: [{ id: "a", pickPose: { x: 0, y: 0 } }] })),
    ).toThrow(/unique/);
    // collides with parking
    expect(() =>
      parseSite(
        JSON.stringify({
          ...base,
          parking: [{ id: "p1", x: 1, y: 1 }],
          locations: [{ id: "p1", pickPose: { x: 2, y: 2 } }],
        }),
      ),
    ).toThrow(/unique/);
    // two locations sharing an id
    expect(() =>
      parseSite(
        JSON.stringify({
          ...base,
          locations: [
            { id: "dup", pickPose: { x: 0, y: 0 } },
            { id: "dup", dropPose: { x: 5, y: 0 } },
          ],
        }),
      ),
    ).toThrow(/unique/);
  });

  test("parking entry must reference a known node", () => {
    const nodes = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 5, y: 0 },
    ];
    expect(
      parseSite(JSON.stringify({ name: "s", nodes, links: [], parking: [{ id: "p1", x: 1, y: 1, entry: "a" }] })).parking,
    ).toHaveLength(1);
    expect(() =>
      parseSite(JSON.stringify({ name: "s", nodes, links: [], parking: [{ id: "p1", x: 1, y: 1, entry: "ghost" }] })),
    ).toThrow(/unique with known entry nodes/);
  });

  test("freeSpot prefers nearest free; occupiedSpots reads poses", () => {
    const spots = [
      { id: "p1", x: 0, y: 0 },
      { id: "p2", x: 10, y: 0 },
    ];
    expect(freeSpot(spots, new Map(), { x: 9, y: 1 })?.id).toBe("p2");
    expect(freeSpot(spots, new Map([["p2", "r1"]]), { x: 9, y: 1 })?.id).toBe("p1");
    expect(freeSpot(spots, new Map([["p1", "a"], ["p2", "b"]]))).toBeUndefined();
    expect(freeSpot(spots, {})?.id).toBe("p1");

    expect(occupiedSpots(spots, [{ x: 0.2, y: 0.1 }])).toEqual({ p1: true });
    expect(occupiedSpots(spots, [{ x: 5, y: 5 }])).toEqual({});
    expect(occupiedSpots(spots, [{ x: Number.NaN, y: 0 }])).toEqual({});
  });
});
