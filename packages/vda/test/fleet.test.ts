import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import { Fleet } from "../src/fleet.js";
import { MemoryHub, attachMemoryTransport } from "../src/fakeMqtt.js";

const options: ClientOptions = {
  interfaceName: "fleet-test",
  vdaVersion: "2.0.0",
  transport: { brokerUrl: "mqtt://memory" },
  topicObjectValidation: { inbound: false, outbound: false },
};

async function startAgv(hub: MemoryHub, id: AgvId, x: number, y: number) {
  const controller = new AgvController(
    id,
    options,
    { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
    {
      vehicleSpeed: 4,
      initialPosition: { mapId: "local", x, y, theta: 0, lastNodeId: "0" },
    },
  );
  attachMemoryTransport(controller, hub);
  await controller.start();
  return controller;
}

async function pollFor(label: string, cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("Fleet dispatch with locks", () => {
  test("second robot waits for the shared node, then both finish", async () => {
    const site = {
      name: "corridor",
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 20, y: 0 },
        { id: "c", x: 20, y: 20 },
      ],
      links: [
        { source: "a", destination: "b", bidirectional: true },
        { source: "c", destination: "b", bidirectional: true },
      ],
    };
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();

    const r1 = { manufacturer: "RobotCompany", serialNumber: "fleet-1" };
    const r2 = { manufacturer: "RobotCompany", serialNumber: "fleet-2" };
    const c1 = await startAgv(hub, r1, 0, 0);
    const c2 = await startAgv(hub, r2, 20, 20);
    const fleet = new Fleet(master, locks);

    try {
      const p1 = fleet.dispatch(r1, [
        { nodeId: "a", x: 0, y: 0 },
        { nodeId: "b", x: 20, y: 0 },
      ]);
      // r1 takes the shared node first
      await pollFor(
        "r1 to hold b",
        () => locks.snapshot().nodeLocks.find((n) => n.id === "b")?.owners.includes("fleet-1") ?? false,
        20_000,
      );

      const state: { done: string | null } = { done: null };
      const p2 = fleet
        .dispatch(r2, [
          { nodeId: "c", x: 20, y: 20 },
          { nodeId: "b", x: 20, y: 0 },
        ])
        .then(
          () => {
            state.done = "ok";
          },
          (e: unknown) => {
            state.done = `failed: ${String(e)}`;
          },
        );

      // r2 must still be waiting while r1 holds b
      await new Promise((r) => setTimeout(r, 2500));
      expect(state.done).toBeNull();
      expect(locks.snapshot().nodeLocks.find((n) => n.id === "b")?.owners).toEqual(["fleet-1"]);

      await p1;
      await p2;
      expect(state.done).toBe("ok");
      expect(locks.snapshot().nodeLocks.every((n) => n.owners.length === 0)).toBe(true);
    } finally {
      await c1.stop();
      await c2.stop();
      await master.stop();
    }
  }, 120_000);
});
