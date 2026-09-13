import { describe, expect, test } from "bun:test";
import { parseSite } from "../src/site.js";

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
    ).toThrow(/entries must reference/);
  });
});
