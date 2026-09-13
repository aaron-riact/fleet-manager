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
});
