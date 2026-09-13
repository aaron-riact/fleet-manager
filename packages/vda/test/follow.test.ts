import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import { Fleet } from "../src/fleet.js";
import { MemoryHub, attachMemoryTransport } from "../src/fakeMqtt.js";

const options: ClientOptions = {
  interfaceName: "follow-test",
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
      vehicleSpeed: 8,
      initialPosition: { mapId: "local", x, y, theta: 0, lastNodeId: "0" },
    },
  );
  attachMemoryTransport(controller, hub);
  await controller.start();
  return controller;
}

const site = {
  name: "tri",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 8, y: 0 },
    { id: "c", x: 8, y: 6 },
  ],
  links: [
    { source: "a", destination: "b", bidirectional: true },
    { source: "b", destination: "c", bidirectional: true },
    { source: "c", destination: "a", bidirectional: true },
  ],
};

const tour = [
  { nodeId: "a", x: 0, y: 0 },
  { nodeId: "b", x: 8, y: 0 },
  { nodeId: "c", x: 8, y: 6 },
  { nodeId: "a", x: 0, y: 0 },
];

describe("shared loop following", () => {
  test("follower trails the leader, finishes after it parks", async () => {
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();

    const r1 = { manufacturer: "RobotCompany", serialNumber: "fol-1" };
    const r2 = { manufacturer: "RobotCompany", serialNumber: "fol-2" };
    const c1 = await startAgv(hub, r1, 0, 0);
    const c2 = await startAgv(hub, r2, 0, 0);
    const fleet = new Fleet(master, locks);
    const state: { done1: boolean; done2: boolean } = { done1: false, done2: false };

    try {
      const p1 = fleet.dispatch(r1, tour).then(
        () => (state.done1 = true),
        () => (state.done1 = false),
      );
      // stagger the follower like two button clicks (leader clears entry first)
      await new Promise((r) => setTimeout(r, 3000));
      const p2 = fleet.dispatch(r2, tour).then(
        () => (state.done2 = true),
        () => (state.done2 = false),
      );

      await p1;
      expect(state.done1).toBe(true);
      // leader idles on its final node; follower cannot take it yet
      expect(locks.snapshot().nodeLocks.find((n) => n.id === "a")?.owners).toEqual(["fol-1"]);

      // leader parks off-graph: follower now runs the loop to completion
      await fleet.park(r1, { id: "p1", x: 4, y: 3 }, { from: { x: 0, y: 0 } });
      await p2;
      expect(state.done2).toBe(true);
      expect(locks.snapshot().nodeLocks.find((n) => n.id === "a")?.owners).toEqual(["fol-2"]);
    } finally {
      await c1.stop();
      await c2.stop();
      await master.stop();
    }
  }, 150_000);
});
