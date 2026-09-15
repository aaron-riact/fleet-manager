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

async function startAgv(hub: MemoryHub, manufacturer: string, serial: string) {
  const id: AgvId = { manufacturer, serialNumber: serial };
  const controller = new AgvController(
    id,
    options,
    { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
    { vehicleSpeed: 2 },
  );
  attachMemoryTransport(controller, hub);
  await controller.start();
  return controller;
}

describe("watchRobots", () => {
  test("streams numeric poses for running AGVs", async () => {
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const controller = await startAgv(hub, "RobotCompany", "pose-1");
    try {
      const latest = new Map<string, RobotPose>();
      const stop = await watchRobots(master, "RobotCompany", (pose) => {
        latest.set(pose.serialNumber, pose);
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!latest.has("pose-1") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const pose = latest.get("pose-1");
        expect(pose).toBeDefined();
        expect(Number.isFinite(pose!.x)).toBe(true);
        expect(Number.isFinite(pose!.y)).toBe(true);
      } finally {
        stop();
      }
    } finally {
      await controller.stop();
      await master.stop();
    }
  }, 15_000);

  test("wildcard manufacturer sees every maker", async () => {
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const c1 = await startAgv(hub, "MakerA", "wild-1");
    const c2 = await startAgv(hub, "MakerB", "wild-2");
    try {
      const seen = new Map<string, RobotPose>();
      const stop = await watchRobots(master, undefined, (pose) => {
        seen.set(pose.serialNumber, pose);
      });
      try {
        const deadline = Date.now() + 10_000;
        while ((!seen.has("wild-1") || !seen.has("wild-2")) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(seen.get("wild-1")?.manufacturer).toBe("MakerA");
        expect(seen.get("wild-2")?.manufacturer).toBe("MakerB");
      } finally {
        stop();
      }
    } finally {
      await c1.stop();
      await c2.stop();
      await master.stop();
    }
  }, 15_000);
});
