import { describe, expect, test } from "bun:test";
import { buildIncrementalOrder, stitchRelease } from "../src/fleet.js";

const waypoints = [
  { nodeId: "a", x: 0, y: 0 },
  { nodeId: "b", x: 5, y: 0 },
  { nodeId: "c", x: 10, y: 0 },
];

describe("order building", () => {
  test("incremental order releases only the first node", () => {
    const { order, sequenceOf } = buildIncrementalOrder("o1", waypoints);
    expect(order.nodes.map((n) => [n.nodeId, n.sequenceId, n.released])).toEqual([
      ["a", 0, true],
      ["b", 2, false],
      ["c", 4, false],
    ]);
    expect(order.edges.map((e) => [e.sequenceId, e.released])).toEqual([
      [1, false],
      [3, false],
    ]);
    expect(sequenceOf.get("c")).toBe(4);
  });

  test("stitch releases granted nodes and covered edges", () => {
    const { order } = buildIncrementalOrder("o1", waypoints);
    const update = stitchRelease(order, [0, 2], 1, 0) as unknown as {
      orderUpdateId: number;
      nodes: Array<{ sequenceId: number; released: boolean }>;
      edges: Array<{ sequenceId: number; released: boolean }>;
    };
    expect(update.orderUpdateId).toBe(1);
    expect(update.nodes.map((n) => n.released)).toEqual([true, true, false]);
    expect(update.edges.map((e) => e.released)).toEqual([true, false]);
    // base order untouched
    expect(order.nodes[1]?.released).toBe(false);
  });

  test("stitch prunes traversed nodes, keeping the base", () => {
    const { order } = buildIncrementalOrder("o1", waypoints);
    const update = stitchRelease(order, [0, 2, 4], 2, 2) as unknown as {
      nodes: Array<{ sequenceId: number; released: boolean }>;
      edges: Array<{ sequenceId: number }>;
    };
    expect(update.nodes.map((n) => n.sequenceId)).toEqual([2, 4]);
    expect(update.nodes[0]).toMatchObject({ released: true, actions: [] });
    expect(update.edges.map((e) => e.sequenceId)).toEqual([3]);
  });

  test("empty waypoints rejected", () => {
    expect(() => buildIncrementalOrder("o", [])).toThrow(/at least one waypoint/);
  });
});
