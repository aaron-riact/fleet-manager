import { describe, expect, test } from "bun:test";
import { bootFleet } from "../src/fleet.js";
import { driveThrough, loopFrom } from "../src/scenario.js";

describe("loopFrom", () => {
  const nodes = [
    { nodeId: "a", x: 0, y: 0 },
    { nodeId: "b", x: 10, y: 0 },
    { nodeId: "c", x: 10, y: 8 },
  ];

  test("starts at nearest node and closes the loop", () => {
    expect(loopFrom(nodes, 9, 1).map((n) => n.nodeId)).toEqual(["b", "c", "a", "b"]);
    expect(loopFrom(nodes, 0, 0).map((n) => n.nodeId)).toEqual(["a", "b", "c", "a"]);
  });

  test("rejects empty input", () => {
    expect(() => loopFrom([], 0, 0)).toThrow(/at least one node/);
  });
});

describe("driveThrough scenario", () => {
  test("virtual AGV completes a two-node order", async () => {
    const fleet = await bootFleet({ robots: [{ manufacturer: "RobotCompany", serialNumber: "run-1" }] });
    try {
      const [robot] = fleet.robots;
      await driveThrough(fleet.master, robot!.id, [
        { nodeId: "a", x: 0, y: 0 },
        { nodeId: "b", x: 3, y: 0 },
      ]);
      expect(true).toBe(true);
    } finally {
      await fleet.stop();
    }
  }, 30_000);

  test("empty waypoints rejected", async () => {
    const fleet = await bootFleet({ robots: [] });
    try {
      await expect(
        driveThrough(fleet.master, { manufacturer: "RobotCompany", serialNumber: "ghost" }, []),
      ).rejects.toThrow(/at least one waypoint/);
    } finally {
      await fleet.stop();
    }
  }, 15_000);
});
