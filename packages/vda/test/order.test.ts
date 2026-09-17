import { describe, expect, test } from "bun:test";
import type { MasterController } from "vda-5050-lib";
import type { FleetLocks } from "@fleet-manager/core";
import { Fleet, buildIncrementalOrder, stitchRelease } from "../src/fleet.js";

const waypoints = [
  { nodeId: "a", x: 0, y: 0 },
  { nodeId: "b", x: 5, y: 0 },
  { nodeId: "c", x: 10, y: 0 },
];

describe("order building", () => {
  test("incremental order releases only the first node", () => {
    const { order, sequenceOf } = buildIncrementalOrder("o1", waypoints);
    expect(order.nodes.map((n) => [n.nodeId, n.sequenceId, n.released])).toEqual([
      ["a", 0, true],
      ["b", 2, false],
      ["c", 4, false],
    ]);
    expect(order.edges.map((e) => [e.sequenceId, e.released])).toEqual([
      [1, false],
      [3, false],
    ]);
    expect(sequenceOf.get("c")).toBe(4);
  });

  test("stitch releases granted nodes and covered edges", () => {
    const { order } = buildIncrementalOrder("o1", waypoints);
    const update = stitchRelease(order, [0, 2], 1, 0) as unknown as {
      orderUpdateId: number;
      nodes: Array<{ sequenceId: number; released: boolean }>;
      edges: Array<{ sequenceId: number; released: boolean }>;
    };
    expect(update.orderUpdateId).toBe(1);
    expect(update.nodes.map((n) => n.released)).toEqual([true, true, false]);
    expect(update.edges.map((e) => e.released)).toEqual([true, false]);
    // base order untouched
    expect(order.nodes[1]?.released).toBe(false);
  });

  test("stitch prunes traversed nodes, keeping the base", () => {
    const { order } = buildIncrementalOrder("o1", waypoints);
    const update = stitchRelease(order, [0, 2, 4], 2, 2) as unknown as {
      nodes: Array<{ sequenceId: number; released: boolean }>;
      edges: Array<{ sequenceId: number }>;
    };
    expect(update.nodes.map((n) => n.sequenceId)).toEqual([2, 4]);
    expect(update.nodes[0]).toMatchObject({ released: true, actions: [] });
    expect(update.edges.map((e) => e.sequenceId)).toEqual([3]);
  });

  test("empty waypoints rejected", () => {
    expect(() => buildIncrementalOrder("o", [])).toThrow(/at least one waypoint/);
  });
});

describe("order history", () => {
  function stubMaster(failWith?: unknown): MasterController {
    return {
      assignOrder: async (
        _agv: unknown,
        _order: unknown,
        cb: {
          onOrderProcessed: (error: unknown, cancelled: boolean, active: boolean) => void;
        },
      ) => {
        queueMicrotask(() => cb.onOrderProcessed(failWith ?? undefined, false, false));
      },
    } as unknown as MasterController;
  }

  function stubLocks(): FleetLocks {
    return {
      lockerFor: () => ({
        makePathLocker: () => ({
          arrivedAt: () => {},
          clearAllPathLocks: () => {},
          clearAllExceptLastPathLocks: () => {},
        }),
        clearAllLocks: () => {},
      }),
      holdNode: () => true,
      snapshot: () => ({ nodeLocks: [], edgeLocks: [] }),
    } as unknown as FleetLocks;
  }

  /** Like stubLocks, but the path locker releases the next node on arrival. */
  function releasingLocks(): FleetLocks {
    return {
      lockerFor: () => ({
        makePathLocker: (_nodeIds: string[], onGrant: (next: Array<{ index: number }>) => void) => ({
          arrivedAt: () => onGrant([{ index: 1 }]),
          clearAllPathLocks: () => {},
          clearAllExceptLastPathLocks: () => {},
        }),
        clearAllLocks: () => {},
      }),
      holdNode: () => true,
      snapshot: () => ({ nodeLocks: [], edgeLocks: [] }),
    } as unknown as FleetLocks;
  }

  const robot = (serial: string) => ({ manufacturer: "Test", serialNumber: serial });

  test("dispatch resolves the order id for history lookup", async () => {
    const fleet = new Fleet(stubMaster(), stubLocks());
    const orderId = await fleet.dispatch(robot("h-id"), waypoints);
    expect(orderId).toMatch(/^fleet-order-/);
    expect(fleet.orderHistory().map((h) => h.orderId)).toEqual([orderId]);
  });

  test("failed dispatch records the reason", async () => {
    const fleet = new Fleet(stubMaster(new Error("boom")), stubLocks());
    await expect(fleet.dispatch(robot("h-fail"), waypoints)).rejects.toThrow(/boom/);
    expect(fleet.activeOrderList()).toEqual([]);
    const history = fleet.orderHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ serial: "h-fail", outcome: "failed", reason: "boom" });
  });

  test("newest first, bounded by maxEntries", async () => {
    const fleet = new Fleet(stubMaster(), stubLocks(), {}, { maxEntries: 3 });
    for (const serial of ["h-0", "h-1", "h-2", "h-3", "h-4"]) {
      await fleet.dispatch(robot(serial), waypoints);
    }
    const history = fleet.orderHistory();
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.serial)).toEqual(["h-4", "h-3", "h-2"]);
    expect(history.every((h) => h.outcome === "completed")).toBe(true);
  });

  test("an order is recorded once even if both end paths fire", async () => {
    // the lib may invoke onOrderProcessed AND reject the assign promise
    // for the same order; that is one tour, so one history entry
    const master = {
      assignOrder: async (
        _agv: unknown,
        _order: unknown,
        cb: { onOrderProcessed: (e: unknown, c: boolean, a: boolean) => void },
      ) => {
        cb.onOrderProcessed(undefined, false, false);
        throw new Error("late transport failure");
      },
    } as unknown as MasterController;
    const fleet = new Fleet(master, stubLocks());
    await fleet.dispatch(robot("h-both"), waypoints).catch(() => {});
    const history = fleet.orderHistory();
    expect(history).toHaveLength(1);
    // the first end wins: the tour did complete
    expect(history[0]).toMatchObject({ serial: "h-both", outcome: "completed" });
  });

  test("a failed mid-tour release is recorded, not just rejected", async () => {
    // the first assign succeeds and the robot traverses; the release
    // that follows fails, which ends the tour
    let assigns = 0;
    const master = {
      assignOrder: async (
        _agv: unknown,
        _order: unknown,
        cb: { onNodeTraversed: (n: { nodeId: string; sequenceId?: number }) => void },
      ) => {
        assigns += 1;
        if (assigns > 1) throw new Error("release rejected");
        queueMicrotask(() => cb.onNodeTraversed({ nodeId: "a", sequenceId: 0 }));
      },
    } as unknown as MasterController;
    const fleet = new Fleet(master, releasingLocks());
    await expect(fleet.dispatch(robot("h-rel"), waypoints)).rejects.toThrow(/release rejected/);
    const history = fleet.orderHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      serial: "h-rel",
      outcome: "failed",
      reason: "release rejected",
    });
    expect(fleet.activeOrderList()).toEqual([]);
  });

  test("maxAgeMs drops stale entries on read", async () => {
    const fleet = new Fleet(stubMaster(), stubLocks(), {}, { maxAgeMs: 1 });
    await fleet.dispatch(robot("h-old"), waypoints);
    expect(fleet.orderHistory()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(fleet.orderHistory()).toEqual([]);
  });
});
