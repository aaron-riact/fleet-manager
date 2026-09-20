import { describe, expect, test } from "bun:test";
import { zoneRows } from "../src/DemandBoard.js";

const nodes = [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 10, y: 0 },
];

describe("zoneRows", () => {
  test("one row per zoned drop location, counts joined, drop node nearest", () => {
    const rows = zoneRows(
      [
        { id: "dock", zone: "east", dropPose: { x: 9, y: 0 } },
        { id: "dock-pick", zone: "east", pickPose: { x: 9, y: 1 } },
        { id: "bay", zone: "west", dropPose: { x: 1, y: 0 } },
        { id: "unzoned", dropPose: { x: 5, y: 5 } },
      ],
      nodes,
      [{ zone: "east", demand: 2 }],
    );
    expect(rows).toEqual([
      { zone: "east", demand: 2, dropNode: "b" },
      { zone: "west", demand: 0, dropNode: "a" },
    ]);
  });

  test("locations without a drop pose and empty inputs yield nothing", () => {
    expect(zoneRows([{ id: "x", zone: "east", pickPose: { x: 0, y: 0 } }], nodes, [])).toEqual([]);
    expect(zoneRows([], nodes, [{ zone: "east", demand: 1 }])).toEqual([]);
  });
});
