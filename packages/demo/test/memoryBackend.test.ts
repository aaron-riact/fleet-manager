import { describe, expect, test } from "bun:test";
import type { Site } from "@fleet-manager/core";
import { createMemoryBackend } from "../src/memoryBackend.js";

const site: Site = { name: "demo", nodes: [{ id: "a", x: 0, y: 0 }], links: [] };

describe("createMemoryBackend", () => {
  test("serves the seed site", async () => {
    const backend = createMemoryBackend(site);
    expect(await backend.listSites()).toEqual(["demo"]);
    expect(await backend.getMap("demo")).toBe(site);
  });

  test("fans pose, lock, order, and history events out to subscribers", () => {
    const backend = createMemoryBackend(site);
    const poses: unknown[] = [];
    const locks: unknown[] = [];
    const orders: unknown[] = [];
    const history: unknown[] = [];
    const un1 = backend.watchPoses("demo", (p) => void poses.push(p));
    const un2 = backend.watchLocks("demo", (s) => void locks.push(s));
    const un3 = backend.watchOrders("demo", (o) => void orders.push(o));
    const un4 = backend.watchHistory("demo", (h) => void history.push(h));

    backend.emitPose({ manufacturer: "m", serialNumber: "r1", x: 1, y: 2, theta: 0, driving: false });
    backend.emitLocks({ nodeLocks: [], edgeLocks: [] });
    backend.emitOrders([]);
    backend.emitHistory([]);
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(history).toHaveLength(1);

    un1();
    un2();
    un3();
    un4();
    backend.emitPose({ manufacturer: "m", serialNumber: "r1", x: 1, y: 2, theta: 0, driving: false });
    backend.emitLocks({ nodeLocks: [], edgeLocks: [] });
    backend.emitOrders([]);
    backend.emitHistory([]);
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(history).toHaveLength(1);
  });

  test("dispatch delegates to actions, or fails clearly", async () => {
    const calls: unknown[] = [];
    const backend = createMemoryBackend(site, {
      dispatchOrder: async (name, input) => {
        calls.push([name, input]);
      },
    });
    const input = { serialNumber: "r1", waypoints: [{ nodeId: "a", x: 0, y: 0 }] };
    await backend.dispatchOrder("demo", input);
    expect(calls).toEqual([["demo", input]]);

    const bare = createMemoryBackend(site);
    await expect(bare.dispatchOrder("demo", input)).rejects.toThrow(/no dispatcher/);
  });

  test("park and cancel delegate to actions, or fail clearly", async () => {
    const calls: string[] = [];
    const input = { serialNumber: "r1" };
    const backend = createMemoryBackend(site, {
      dispatchOrder: async () => {},
      parkRobot: async (name, arg) => {
        calls.push(`park:${name}:${arg.serialNumber}`);
        return { spot: "p1" };
      },
      cancelOrder: async (name, arg) => {
        calls.push(`cancel:${name}:${arg.serialNumber}`);
      },
    });
    await expect(backend.parkRobot("demo", input)).resolves.toEqual({ spot: "p1" });
    await expect(backend.cancelOrder("demo", input)).resolves.toBeUndefined();
    expect(calls).toEqual(["park:demo:r1", "cancel:demo:r1"]);

    const bare = createMemoryBackend(site);
    await expect(bare.parkRobot("demo", input)).rejects.toThrow(/no dispatcher/);
    await expect(bare.cancelOrder("demo", input)).rejects.toThrow(/no dispatcher/);
  });
});
