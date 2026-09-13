import { describe, expect, test } from "bun:test";
import { boundsOf, indexNodes, toSvg, viewBoxFor } from "../src/map.js";

const nodes = [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 10, y: 8 },
];

describe("map projection", () => {
  test("bounds, y-flip, viewBox", () => {
    const b = boundsOf({ nodes });
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 8 });
    expect(toSvg(0, 0, b)).toEqual({ x: 0, y: 8 });
    expect(toSvg(10, 8, b)).toEqual({ x: 10, y: 0 });
    expect(viewBoxFor(b, 1)).toBe("-1 -1 12 10");
  });

  test("node index", () => {
    expect(indexNodes(nodes).get("b")).toEqual({ id: "b", x: 10, y: 8 });
  });
});
