import { describe, expect, test } from "bun:test";
import { taskStations } from "../src/TaskBoard.js";

describe("taskStations", () => {
  test("tasks offer stations, each only in the roles it has a pose for", () => {
    const { pickups, dropoffs } = taskStations([
      { id: "lounge", name: "Lounge", pickPose: { x: 0, y: 0 }, dropPose: { x: 0, y: 1 } },
      { id: "bay", pickPose: { x: 1, y: 0 } },
      { id: "shelf", name: "Shelf", dropPose: { x: 2, y: 0 } },
    ]);
    // a pick-only station as a dropoff would drive there and do nothing
    expect(pickups).toEqual([
      { id: "lounge", label: "Lounge" },
      { id: "bay", label: "bay" },
    ]);
    expect(dropoffs).toEqual([
      { id: "lounge", label: "Lounge" },
      { id: "shelf", label: "Shelf" },
    ]);
  });

  test("a site without stations offers nothing", () => {
    expect(taskStations([])).toEqual({ pickups: [], dropoffs: [] });
  });
});
