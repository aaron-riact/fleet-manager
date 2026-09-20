import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { watchConnections, watchRobots, watchStates } from "../src/robots.js";
import type { RawState, RobotConnection, RobotPose } from "../src/robots.js";
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
        expect(typeof pose!.charging).toBe("boolean");
        expect(typeof pose!.positionInitialized).toBe("boolean");
        expect(typeof pose!.eStop).toBe("boolean");
        expect(typeof pose!.fieldViolation).toBe("boolean");
        expect(typeof pose!.laden).toBe("boolean");
      } finally {
        stop();
      }
    } finally {
      await controller.stop();
      await master.stop();
    }
  }, 15_000);

  test("sparse state degrades to safe defaults", async () => {
    const stub = {
      subscribeTopic: async (_t: unknown, _s: unknown, handler: (o: unknown) => void) => {
        handler({ serialNumber: "sparse-1" });
        return "sub-1";
      },
      unsubscribe: async () => {},
    };
    const seen: RobotPose[] = [];
    const stop = await watchRobots(stub as unknown as MasterController, undefined, (p) =>
      void seen.push(p),
    );
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      serialNumber: "sparse-1",
      manufacturer: "unknown",
      charging: false,
      positionInitialized: false,
      eStop: false,
      fieldViolation: false,
    });
    expect(Number.isNaN(seen[0]!.x)).toBe(true);
    expect(seen[0]!.batteryCharge).toBeUndefined();
  });

  test("tracks ONLINE for running AGVs", async () => {
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const controller = await startAgv(hub, "RobotCompany", "conn-1");
    try {
      const latest = new Map<string, RobotConnection>();
      const stop = watchConnections(master, (conn) => {
        latest.set(conn.serialNumber, conn);
      });
      try {
        const deadline = Date.now() + 10_000;
        while (latest.get("conn-1")?.state !== "ONLINE" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(latest.get("conn-1")).toMatchObject({
          manufacturer: "RobotCompany",
          serialNumber: "conn-1",
          state: "ONLINE",
        });
      } finally {
        stop();
      }
    } finally {
      await controller.stop();
      await master.stop();
    }
  }, 15_000);

  test("forwards raw state bodies untouched", async () => {
    const body = {
      serialNumber: "raw-1",
      manufacturer: "MakerA",
      driving: true,
      batteryState: { charging: true },
    };
    const stub = {
      subscribeTopic: async (_t: unknown, _s: unknown, handler: (o: unknown) => void) => {
        handler(body);
        return "sub-9";
      },
      unsubscribe: async () => {},
    };
    const seen: RawState[] = [];
    const stop = await watchStates(stub as unknown as MasterController, undefined, (s) =>
      void seen.push(s),
    );
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ manufacturer: "MakerA", serialNumber: "raw-1" });
    expect(seen[0]!.body).toBe(body);
  });

  test("laden follows the reported loads array", async () => {
    const stubFor = (loads: unknown) => ({
      subscribeTopic: async (_t: unknown, _s: unknown, handler: (o: unknown) => void) => {
        handler({ serialNumber: "load-1", loads });
        return "sub-l";
      },
      unsubscribe: async () => {},
    });
    const seen: RobotPose[] = [];
    const stopLaden = await watchRobots(
      stubFor([{ loadType: "pallet" }]) as unknown as MasterController,
      undefined,
      (p) => void seen.push(p),
    );
    stopLaden();
    const stopEmpty = await watchRobots(
      stubFor([]) as unknown as MasterController,
      undefined,
      (p) => void seen.push(p),
    );
    stopEmpty();
    const stopMissing = await watchRobots(
      stubFor(undefined) as unknown as MasterController,
      undefined,
      (p) => void seen.push(p),
    );
    stopMissing();
    expect(seen.map((p) => p.laden)).toEqual([true, false, false]);
  });

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
