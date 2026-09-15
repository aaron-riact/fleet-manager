import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { watchRobots } from "../src/robots.js";
import type { RobotPose } from "../src/robots.js";
import { MemoryHub, attachMemoryTransport } from "../src/fakeMqtt.js";

const options: ClientOptions = {
  interfaceName: "robots-test",
  vdaVersion: "2.0.0",
  transport: { brokerUrl: "mqtt://memory" },
  topicObjectValidation: { inbound: false, outbound: false },
};

describe("watchRobots", () => {
  test("streams numeric poses for running AGVs", async () => {
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const id: AgvId = { manufacturer: "RobotCompany", serialNumber: "pose-1" };
    const controller = new AgvController(
      id,
      options,
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 2 },
    );
    attachMemoryTransport(controller, hub);
    await controller.start();
    try {
      const latest = new Map<string, RobotPose>();
      const stop = await watchRobots(master, "RobotCompany", (pose) => {
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
      await controller.stop();
      await master.stop();
    }
  }, 15_000);
});
