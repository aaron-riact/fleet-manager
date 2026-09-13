import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import type { LockSnapshot } from "@fleet-manager/core";
import { Fleet } from "../src/fleet.js";
import type { ActiveOrder } from "../src/fleet.js";
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
  test("lock snapshots stream from dispatch events", async () => {    const site = {
      name: "short",
      nodes: [
        { id: "x", x: 0, y: 0 },
        { id: "y", x: 3, y: 0 },
      ],
      links: [{ source: "x", destination: "y", bidirectional: true }],
    };
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const r = { manufacturer: "RobotCompany", serialNumber: "snap-1" };
    const c = await startAgv(hub, r, 0, 0);
    const seen: LockSnapshot[] = [];
    const fleet = new Fleet(master, locks, { onLocks: (snap) => void seen.push(snap) });
    try {
      await fleet.dispatch(r, [
        { nodeId: "x", x: 0, y: 0 },
        { nodeId: "y", x: 3, y: 0 },
      ]);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((s) => s.nodeLocks.find((n) => n.id === "x")?.owners.includes("snap-1"))).toBe(true);
      // idle robots keep holding the node they sit on
      const last = seen[seen.length - 1]!;
      expect(last.nodeLocks.find((n) => n.id === "y")?.owners).toEqual(["snap-1"]);
    } finally {
      await c.stop();
      await master.stop();
    }
  }, 60_000);
  test("second robot follows as soon as the shared node is free", async () => {
    const site = {
      name: "corridor",
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 10, y: 0 },
        { id: "c", x: 20, y: 0 },
        { id: "d", x: 10, y: 10 },
      ],
      links: [
        { source: "a", destination: "b", bidirectional: true },
        { source: "b", destination: "c", bidirectional: true },
        { source: "d", destination: "b", bidirectional: true },
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
    const c2 = await startAgv(hub, r2, 10, 10);
    const fleet = new Fleet(master, locks);

    try {
      // r1 passes through b on its way to c; r2 wants b from d
      const p1 = fleet.dispatch(r1, [
        { nodeId: "a", x: 0, y: 0 },
        { nodeId: "b", x: 10, y: 0 },
        { nodeId: "c", x: 20, y: 0 },
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
          { nodeId: "d", x: 10, y: 10 },
          { nodeId: "b", x: 10, y: 0 },
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

      // r1 moves on to c and releases b; r2 follows in
      await p1;
      await p2;
      expect(state.done).toBe("ok");
      // each sits on its final node, holding it
      expect(locks.snapshot().nodeLocks.find((n) => n.id === "c")?.owners).toEqual(["fleet-1"]);
      expect(locks.snapshot().nodeLocks.find((n) => n.id === "b")?.owners).toEqual(["fleet-2"]);
    } finally {
      await c1.stop();
      await c2.stop();
      await master.stop();
    }
  }, 120_000);

  test("far start drives an approach leg first, then the locked tour", async () => {
    const site = {
      name: "short",
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 5, y: 0 },
      ],
      links: [{ source: "a", destination: "b", bidirectional: true }],
    };
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const r = { manufacturer: "RobotCompany", serialNumber: "far-1" };
    const c = await startAgv(hub, r, 10, 10);
    const fleet = new Fleet(master, locks);
    try {
      await fleet.dispatch(
        r,
        [
          { nodeId: "a", x: 0, y: 0 },
          { nodeId: "b", x: 5, y: 0 },
        ],
        { from: { x: 10, y: 10 } },
      );
      expect(locks.snapshot().nodeLocks.find((n) => n.id === "b")?.owners).toEqual(["far-1"]);
    } finally {
      await c.stop();
      await master.stop();
    }
  }, 90_000);

  test("orders feed tracks release state and removal", async () => {
    const site = {
      name: "short",
      nodes: [
        { id: "x", x: 0, y: 0 },
        { id: "y", x: 3, y: 0 },
      ],
      links: [{ source: "x", destination: "y", bidirectional: true }],
    };
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const r = { manufacturer: "RobotCompany", serialNumber: "ord-1" };
    const c = await startAgv(hub, r, 0, 0);
    const seen: ActiveOrder[][] = [];
    const fleet = new Fleet(master, locks, { onOrders: (list) => void seen.push(list) });
    try {
      await fleet.dispatch(r, [
        { nodeId: "x", x: 0, y: 0 },
        { nodeId: "y", x: 3, y: 0 },
      ]);
      expect(seen.length).toBeGreaterThan(0);
      const first = seen[0]![0]!;
      expect(first.serial).toBe("ord-1");
      expect(first.nodes.map((n) => n.released)).toEqual([true, false]);
      const last = seen[seen.length - 1]!;
      expect(last).toEqual([]);
    } finally {
      await c.stop();
      await master.stop();
    }
  }, 60_000);

  test("park drives off-graph and holds no locks", async () => {
    const site = {
      name: "short",
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 5, y: 0 },
      ],
      links: [{ source: "a", destination: "b", bidirectional: true }],
    };
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const r = { manufacturer: "RobotCompany", serialNumber: "park-1" };
    const c = await startAgv(hub, r, 0, 0);
    const fleet = new Fleet(master, locks);
    try {
      await fleet.dispatch(r, [
        { nodeId: "a", x: 0, y: 0 },
        { nodeId: "b", x: 5, y: 0 },
      ]);
      await fleet.park(r, { id: "p1", x: 10, y: 10 }, { from: { x: 5, y: 0 } });
      expect(locks.snapshot().nodeLocks.every((n) => n.owners.length === 0)).toBe(true);
      expect(locks.snapshot().edgeLocks.every((e) => !e.held)).toBe(true);
    } finally {
      await c.stop();
      await master.stop();
    }
  }, 90_000);
});
