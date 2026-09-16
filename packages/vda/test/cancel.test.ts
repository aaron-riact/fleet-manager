import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import { Fleet } from "../src/fleet.js";
import { MemoryHub, attachMemoryTransport } from "../src/fakeMqtt.js";

const options: ClientOptions = {
  interfaceName: "cancel-test",
  vdaVersion: "2.0.0",
  transport: { brokerUrl: "mqtt://memory" },
  topicObjectValidation: { inbound: false, outbound: false },
};

const site = {
  name: "line",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 30, y: 0 },
    { id: "c", x: 60, y: 0 },
  ],
  links: [
    { source: "a", destination: "b", bidirectional: true },
    { source: "b", destination: "c", bidirectional: true },
  ],
};

const tour = [
  { nodeId: "a", x: 0, y: 0 },
  { nodeId: "b", x: 30, y: 0 },
  { nodeId: "c", x: 60, y: 0 },
];

async function pollFor(label: string, cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("Fleet.cancel", () => {
  test("cancelling mid-tour stops the robot and frees everything", async () => {
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const r: AgvId = { manufacturer: "RobotCompany", serialNumber: "cx-1" };
    const controller = new AgvController(
      r,
      options,
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      {
        vehicleSpeed: 4,
        initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" },
      },
    );
    attachMemoryTransport(controller, hub);
    await controller.start();
    const fleet = new Fleet(master, locks);
    try {
      const driving = fleet.dispatch(r, tour);
      driving.catch(() => {});
      // wait until the tour is genuinely underway (holding b)
      await pollFor(
        "tour underway",
        () => locks.snapshot().nodeLocks.find((n) => n.id === "b")?.owners.includes("cx-1") ?? false,
        20_000,
      );
      await fleet.cancel(r);
      expect(fleet.isBusy("cx-1")).toBe(false);
      const snap = locks.snapshot();
      expect(snap.nodeLocks.every((n) => n.owners.length === 0)).toBe(true);
      expect(snap.edgeLocks.every((e) => !e.held)).toBe(true);
      await expect(driving).rejects.toThrow(/cancelled/);
    } finally {
      await controller.stop();
      await master.stop();
    }
  }, 60_000);

  test("cancel without an active order throws", async () => {
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const fleet = new Fleet(master, locks);
    try {
      await expect(
        fleet.cancel({ manufacturer: "RobotCompany", serialNumber: "ghost" }),
      ).rejects.toThrow(/no active order/);
    } finally {
      await master.stop();
    }
  }, 30_000);
});
