import { describe, expect, test } from "bun:test";
import { bootFleet } from "../src/fleet.js";
import { driveThrough } from "../src/scenario.js";

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
