import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { ActionStatus } from "vda-5050-lib";
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

/** Rejects if `promise` has not settled in time, so a hang fails the test. */
function within<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A master that captures callbacks, so a test replays the lib's events in order. */
function heldMaster() {
  const held = {
    orderCallbacks: [] as Array<{
      onOrderProcessed: (error: unknown, cancelled: boolean, active: boolean) => void;
    }>,
    cancelAction: undefined as
      | { onActionStateChanged: (s: { actionStatus: ActionStatus }, error: unknown) => void }
      | undefined,
    master: undefined as unknown as MasterController,
  };
  held.master = {
    assignOrder: async (_agv: unknown, _order: unknown, cb: (typeof held.orderCallbacks)[number]) => {
      held.orderCallbacks.push(cb);
    },
    initiateInstantActions: async (_agv: unknown, _actions: unknown, cb: typeof held.cancelAction) => {
      held.cancelAction = cb;
    },
    createUuid: () => "cancel-1",
  } as unknown as MasterController;
  return held;
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
      const history = fleet.orderHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ serial: "cx-1", outcome: "cancelled" });
      expect(fleet.activeOrderList()).toEqual([]);
    } finally {
      await controller.stop();
      await master.stop();
    }
  }, 60_000);

  test("a tour dispatched as the cancelled one ends keeps the old path unlocked", async () => {
    // The host pumps queued work out of onOrders, which the cancelled
    // branch fires before cancel() resumes. By then a replacement locker
    // is live, so cancel() skips its clear: the cancelled path must
    // already be released or its nodes stay locked under the robot's name.
    const twoLines = {
      name: "two-lines",
      nodes: [...site.nodes, { id: "d", x: 0, y: 30 }, { id: "e", x: 30, y: 30 }],
      links: [...site.links, { source: "d", destination: "e", bidirectional: true }],
    };
    const locks = buildLocks(twoLines);
    const held = heldMaster();
    const { master, orderCallbacks } = held;
    const r: AgvId = { manufacturer: "RobotCompany", serialNumber: "cx-1" };
    let replacement: Promise<string> | undefined;
    const fleet: Fleet = new Fleet(master, locks, {
      onOrders: () => {
        if (replacement || fleet.isBusy("cx-1")) return;
        replacement = fleet.dispatch(r, [
          { nodeId: "d", x: 0, y: 30 },
          { nodeId: "e", x: 30, y: 30 },
        ]);
        replacement.catch(() => {});
      },
    });
    const driving = fleet.dispatch(r, tour);
    driving.catch(() => {});
    await pollFor(
      "tour holding a",
      () => locks.snapshot().nodeLocks.find((n) => n.id === "a")?.owners.includes("cx-1") ?? false,
      2_000,
    );
    const cancelling = fleet.cancel(r);
    await pollFor("cancel sent", () => held.cancelAction !== undefined, 2_000);
    // Order state reaches the master before the instant action's state.
    orderCallbacks[0]!.onOrderProcessed(undefined, true, false);
    held.cancelAction!.onActionStateChanged({ actionStatus: ActionStatus.Finished }, undefined);
    await cancelling;
    await expect(driving).rejects.toThrow(/cancelled/);
    expect(replacement).toBeDefined();
    const owned = locks
      .snapshot()
      .nodeLocks.filter((n) => n.owners.includes("cx-1"))
      .map((n) => n.id);
    expect(owned.filter((id) => ["a", "b", "c"].includes(id))).toEqual([]);
  }, 10_000);

  test("a cancel the AGV reports FAILED rejects, and the tour ends as it really does", async () => {
    // The lib reports a FAILED instant action through onActionStateChanged,
    // never onActionError, and drops it afterwards: waiting for Finished
    // alone hung cancel(), and the POST cancel with it, for good.
    const locks = buildLocks(site);
    const held = heldMaster();
    const fleet = new Fleet(held.master, locks);
    const r: AgvId = { manufacturer: "RobotCompany", serialNumber: "cx-2" };
    const driving = fleet.dispatch(r, tour);
    await pollFor("order assigned", () => held.orderCallbacks.length > 0, 2_000);
    const cancelling = fleet.cancel(r);
    await pollFor("cancel sent", () => held.cancelAction !== undefined, 2_000);
    held.cancelAction!.onActionStateChanged(
      { actionStatus: ActionStatus.Failed },
      { errorDescription: "no order to cancel" },
    );
    await expect(within("cancel settling", cancelling, 2_000)).rejects.toThrow(/no order to cancel/);
    // The AGV kept driving: its normal end records as completed, not cancelled.
    held.orderCallbacks[0]!.onOrderProcessed(undefined, false, false);
    await expect(driving).resolves.toBeString();
    expect(fleet.orderHistory()[0]).toMatchObject({ serial: "cx-2", outcome: "completed" });
  }, 10_000);

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
