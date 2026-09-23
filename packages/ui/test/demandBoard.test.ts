import { describe, expect, test } from "bun:test";
import { zoneRows } from "../src/DemandBoard.js";

describe("zoneRows", () => {
  test("one row per zone, the first station in it with a drop pose, counts joined", () => {
    const rows = zoneRows(
      [
        { id: "dock-pick", zone: "east", pickPose: { x: 9, y: 1 } },
        { id: "dock", name: "Dock", zone: "east", dropPose: { x: 9, y: 0 } },
        { id: "dock-2", zone: "east", dropPose: { x: 9, y: 2 } },
        { id: "bay", zone: "west", dropPose: { x: 1, y: 0 } },
        { id: "unzoned", dropPose: { x: 5, y: 5 } },
      ],
      [{ zone: "east", demand: 2 }],
    );
    // requests name the station itself; the server turns it into a node
    expect(rows).toEqual([
      { zone: "east", demand: 2, dropStation: "dock", label: "Dock" },
      { zone: "west", demand: 0, dropStation: "bay", label: "bay" },
    ]);
  });

  test("locations without a drop pose and empty inputs yield nothing", () => {
    expect(zoneRows([{ id: "x", zone: "east", pickPose: { x: 0, y: 0 } }], [])).toEqual([]);
    expect(zoneRows([], [{ zone: "east", demand: 1 }])).toEqual([]);
  });
});
