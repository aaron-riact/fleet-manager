import { describe, expect, test } from "bun:test";
import { bootFleet } from "../src/fleet.js";
import { watchRobots } from "../src/robots.js";
import type { RobotPose } from "../src/robots.js";

describe("watchRobots", () => {
  test("streams numeric poses for spawned robots", async () => {
    const fleet = await bootFleet({ robots: [{ manufacturer: "RobotCompany", serialNumber: "pose-1" }] });
    try {
      const latest = new Map<string, RobotPose>();
      const stop = await watchRobots(fleet.master, "RobotCompany", (pose) => {
        latest.set(pose.serialNumber, pose);
      });
      const deadline = Date.now() + 10_000;
      while (!latest.has("pose-1") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const pose = latest.get("pose-1");
      expect(pose).toBeDefined();
      expect(Number.isFinite(pose!.x)).toBe(true);
      expect(Number.isFinite(pose!.y)).toBe(true);
      stop();
    } finally {
      await fleet.stop();
    }
  }, 15_000);
});
