import { describe, expect, test } from "bun:test";
import type { AgvId, MasterController } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import { Fleet } from "../src/fleet.js";

const site = {
  name: "line",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 30, y: 0 },
    { id: "c", x: 60, y: 0 },
    { id: "d", x: 90, y: 0 },
  ],
  links: [
    { source: "a", destination: "b", bidirectional: true },
    { source: "b", destination: "c", bidirectional: true },
    { source: "c", destination: "d", bidirectional: true },
  ],
};

interface OrderCallbacks {
  onNodeTraversed: (node: { nodeId: string; sequenceId?: number }) => void;
  onOrderProcessed: (error: unknown, cancelled: boolean, active: boolean) => void;
}

/** Captures the callbacks of each tour's first assign; the test drives the robot. */
function heldMaster() {
  const tours: OrderCallbacks[] = [];
  const master = {
    assignOrder: async (_agv: unknown, order: { orderUpdateId: number }, cb: OrderCallbacks) => {
      if (order.orderUpdateId === 0) tours.push(cb);
    },
    createUuid: () => "u",
  } as unknown as MasterController;
  return { master, tours };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const heldBy = (locks: ReturnType<typeof buildLocks>, serial: string) =>
  locks
    .snapshot()
    .nodeLocks.filter((n) => n.owners.includes(serial))
    .map((n) => n.id)
    .sort();

describe("idle holds", () => {
  test("the node a robot idled on is released once its next tour drives off it", async () => {
    // A tour that ends on the graph keeps its last node, so nobody drives
    // into the idle robot. Its next tour must give that node up once it
    // drives off, even when its path does not pass the node: graferse
    // 0.2.0 does this (a new path takes over the idle hold). Before, the
    // robot held it for the whole tour, and on a site without parking the
    // stale holds piled up until deadlock.
    const locks = buildLocks(site);
    const { master, tours } = heldMaster();
    const fleet = new Fleet(master, locks);
    const r: AgvId = { manufacturer: "Test", serialNumber: "h-1" };

    const first = fleet.dispatch(r, [
      { nodeId: "a", x: 0, y: 0 },
      { nodeId: "b", x: 30, y: 0 },
    ]);
    await settle();
    tours[0]!.onNodeTraversed({ nodeId: "b", sequenceId: 2 });
    tours[0]!.onOrderProcessed(undefined, false, false);
    await first;
    expect(heldBy(locks, "h-1")).toEqual(["b"]);

    // Off-graph start at the robot's pose on b, then c and d.
    const second = fleet.dispatch(
      r,
      [
        { nodeId: "c", x: 60, y: 0 },
        { nodeId: "d", x: 90, y: 0 },
      ],
      { from: { x: 30, y: 0 } },
    );
    await settle();
    // Still standing on b: the hold must stay.
    expect(heldBy(locks, "h-1")).toContain("b");
    tours[1]!.onNodeTraversed({ nodeId: "c", sequenceId: 2 });
    expect(heldBy(locks, "h-1")).not.toContain("b");
    tours[1]!.onOrderProcessed(undefined, false, false);
    await second;
    expect(heldBy(locks, "h-1")).toEqual(["d"]);
  });

  test("a hold on the new path is the path's to manage", async () => {
    // The tour starts where the robot idles: releasing that node by name
    // would take the lock the new path just claimed on it.
    const locks = buildLocks(site);
    const { master, tours } = heldMaster();
    const fleet = new Fleet(master, locks);
    const r: AgvId = { manufacturer: "Test", serialNumber: "h-2" };

    const first = fleet.dispatch(r, [
      { nodeId: "a", x: 0, y: 0 },
      { nodeId: "b", x: 30, y: 0 },
    ]);
    await settle();
    tours[0]!.onNodeTraversed({ nodeId: "b", sequenceId: 2 });
    tours[0]!.onOrderProcessed(undefined, false, false);
    await first;

    const second = fleet.dispatch(r, [
      { nodeId: "b", x: 30, y: 0 },
      { nodeId: "c", x: 60, y: 0 },
      { nodeId: "d", x: 90, y: 0 },
    ]);
    await settle();
    tours[1]!.onNodeTraversed({ nodeId: "c", sequenceId: 2 });
    // c is current, d is next; b is behind and the path released it itself.
    expect(heldBy(locks, "h-2")).toEqual(["c", "d"]);
    tours[1]!.onOrderProcessed(undefined, false, false);
    await second;
  });
});
