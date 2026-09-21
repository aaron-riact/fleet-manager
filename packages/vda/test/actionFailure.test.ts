import { describe, expect, test } from "bun:test";
import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import { Fleet } from "../src/fleet.js";
import { MemoryHub, attachMemoryTransport } from "../src/fakeMqtt.js";

const options: ClientOptions = {
  interfaceName: "action-failure-test",
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

/**
 * A HARD drop on an empty vehicle: the virtual adapter reports the action
 * FAILED ("no load to drop") without stopping the order itself, which is
 * the case Fleet has to end explicitly.
 */
const failingDrop = {
  actionType: "drop",
  blockingType: "HARD" as const,
  actionParameters: [
    { key: "stationType", value: "floor" },
    { key: "loadType", value: "EPAL" },
  ],
};

async function pollFor(label: string, cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("failed blocking actions", () => {
  test("the dead tour has let go of the graph before onOrderDone fires", async () => {
    const locks = buildLocks(site);
    const hub = new MemoryHub();
    const master = new MasterController(options, {});
    attachMemoryTransport(master, hub);
    await master.start();
    const r: AgvId = { manufacturer: "RobotCompany", serialNumber: "af-1" };
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

    // Both hosts auto-park straight out of onOrderDone, and the dispatch
    // takes its locks synchronously inside the callback. Whatever the dead
    // tour still holds at this instant, cancel() will unlock later by robot
    // name — taking the replacement's locks and its replay closure with it.
    let heldAtDone: string[] | undefined;
    let second: Promise<string> | undefined;
    const fleet = new Fleet(master, locks, {
      onOrderDone: (serial) => {
        if (second) return;
        heldAtDone = locks
          .snapshot()
          .nodeLocks.filter((n) => n.owners.includes(serial))
          .map((n) => n.id);
        second = fleet.dispatch({ manufacturer: "RobotCompany", serialNumber: serial }, [
          { nodeId: "b", x: 30, y: 0 },
          { nodeId: "c", x: 60, y: 0 },
        ]);
        second.catch(() => {});
      },
    });

    try {
      const first = fleet.dispatch(r, [
        { nodeId: "a", x: 0, y: 0 },
        { nodeId: "b", x: 30, y: 0, actions: [failingDrop] },
        { nodeId: "c", x: 60, y: 0 },
      ]);
      await expect(first).rejects.toThrow(/no load to drop/);
      expect(fleet.orderHistory()[0]).toMatchObject({ serial: "af-1", outcome: "failed" });
      expect(heldAtDone).toEqual([]);

      // And the replacement keeps what it took: the late clear in cancel()
      // must find the order already ended and leave the graph alone.
      await pollFor(
        "second tour holding",
        () =>
          locks.snapshot().nodeLocks.some((n) => n.owners.includes("af-1")),
        20_000,
      );
      await new Promise((r) => setTimeout(r, 1500));
      expect(
        locks.snapshot().nodeLocks.filter((n) => n.owners.includes("af-1")).length,
      ).toBeGreaterThan(0);
      expect(fleet.isBusy("af-1")).toBe(true);
    } finally {
      await controller.stop();
      await master.stop();
    }
  }, 60_000);
});
