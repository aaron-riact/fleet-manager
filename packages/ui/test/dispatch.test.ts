import { describe, expect, test } from "bun:test";
import { buildTour, findPath, nearestNode } from "../src/dispatch.js";

const nodes = [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 10, y: 0 },
  { id: "c", x: 10, y: 8 },
];
const links = [
  { source: "a", destination: "b", bidirectional: true },
  { source: "b", destination: "c" },
];

describe("dispatch helpers", () => {
  test("nearest node by squared distance", () => {
    expect(nearestNode(nodes, { x: 1, y: 1 })?.id).toBe("a");
    expect(nearestNode(nodes, { x: 9, y: 7 })?.id).toBe("c");
    expect(nearestNode([], { x: 0, y: 0 })).toBeUndefined();
  });

  test("paths respect direction", () => {
    expect(findPath(links, "a", "c")).toEqual(["a", "b", "c"]);
    expect(findPath(links, "c", "a")).toBeUndefined();
    expect(findPath(links, "b", "b")).toEqual(["b"]);
    expect(findPath(links, "a", "ghost")).toBeUndefined();
  });

  test("station tours resolve through the graph", () => {
    expect(buildTour(nodes, links, { x: 0, y: 0 }, { x: 10, y: 8 })?.map((w) => w.nodeId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(buildTour(nodes, links, { x: 0, y: 0 }, { x: 0, y: 0 })?.map((w) => w.nodeId)).toEqual(["a"]);
    expect(buildTour([], links, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeUndefined();
    expect(buildTour(nodes, links, { x: 10, y: 8 }, { x: 0, y: 0 })).toBeUndefined();
  });
});
