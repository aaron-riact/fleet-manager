import { describe, expect, test } from "bun:test";
import type { Site, TaskView } from "@fleet-manager/core";
import { createMemoryBackend } from "../src/memoryBackend.js";

const site: Site = { name: "demo", nodes: [{ id: "a", x: 0, y: 0 }], links: [] };

describe("createMemoryBackend", () => {
  test("serves the seed site", async () => {
    const backend = createMemoryBackend(site);
    expect(await backend.listSites()).toEqual(["demo"]);
    expect(await backend.getMap("demo")).toBe(site);
  });

  test("fans pose, lock, order, history, and connection events out to subscribers", () => {
    const backend = createMemoryBackend(site);
    const poses: unknown[] = [];
    const locks: unknown[] = [];
    const orders: unknown[] = [];
    const history: unknown[] = [];
    const conns: unknown[] = [];
    const un1 = backend.watchPoses("demo", (p) => void poses.push(p));
    const un2 = backend.watchLocks("demo", (s) => void locks.push(s));
    const un3 = backend.watchOrders("demo", (o) => void orders.push(o));
    const un4 = backend.watchHistory("demo", (h) => void history.push(h));
    const un5 = backend.watchConnections("demo", (c) => void conns.push(c));

    const pose = {
      manufacturer: "m",
      serialNumber: "r1",
      x: 1,
      y: 2,
      theta: 0,
      driving: false,
      laden: false,
      charging: false,
      positionInitialized: true,
      eStop: false,
      fieldViolation: false,
    };
    backend.emitPose(pose);
    backend.emitLocks({ nodeLocks: [], edgeLocks: [] });
    backend.emitOrders([]);
    backend.emitHistory([]);
    backend.emitConnections([]);
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(conns).toHaveLength(1);

    un1();
    un2();
    un3();
    un4();
    un5();
    backend.emitPose(pose);
    backend.emitLocks({ nodeLocks: [], edgeLocks: [] });
    backend.emitOrders([]);
    backend.emitHistory([]);
    backend.emitConnections([]);
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(conns).toHaveLength(1);
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

  test("requests, pickups, and demand bumps delegate to actions, or fail clearly", async () => {
    const calls: unknown[] = [];
    const backend = createMemoryBackend(site, {
      submitRequest: async (name, input) => {
        calls.push(["submitRequest", name, input]);
        return { taskId: "task-9" };
      },
      attachPickup: async (name, taskId, input) => {
        calls.push(["attachPickup", name, taskId, input]);
      },
      bumpDemand: async (name, input) => {
        calls.push(["bumpDemand", name, input]);
        return { zone: input.zone, demand: 3 };
      },
    });
    await expect(backend.submitRequest("demo", { dropoff: "b", zone: "dock" })).resolves.toEqual({
      taskId: "task-9",
    });
    await expect(backend.attachPickup("demo", "task-9", { pickup: "a" })).resolves.toBeUndefined();
    await expect(backend.bumpDemand("demo", { zone: "dock", count: 3 })).resolves.toEqual({
      zone: "dock",
      demand: 3,
    });
    expect(calls).toEqual([
      ["submitRequest", "demo", { dropoff: "b", zone: "dock" }],
      ["attachPickup", "demo", "task-9", { pickup: "a" }],
      ["bumpDemand", "demo", { zone: "dock", count: 3 }],
    ]);

    const bare = createMemoryBackend(site);
    await expect(bare.submitRequest("demo", { dropoff: "b" })).rejects.toThrow(/no dispatcher/);
    await expect(bare.attachPickup("demo", "task-9", { pickup: "a" })).rejects.toThrow(/no dispatcher/);
    await expect(bare.bumpDemand("demo", { zone: "dock", count: 1 })).rejects.toThrow(/no dispatcher/);
  });

  test("demands fan out to subscribers", () => {
    const backend = createMemoryBackend(site);
    const seen: unknown[] = [];
    const stop = backend.watchDemands("demo", (d) => void seen.push(d));
    backend.emitDemands([{ zone: "dock", demand: 2 }]);
    expect(seen).toEqual([[{ zone: "dock", demand: 2 }]]);
    stop();
    backend.emitDemands([]);
    expect(seen).toHaveLength(1);
  });

  test("bulk park delegates to actions, or fails clearly", async () => {
    const calls: unknown[] = [];
    const result = {
      parked: [{ serialNumber: "r1", spot: "p1" }],
      failed: [],
    };
    const backend = createMemoryBackend(site, {
      parkRobots: async (name, input) => {
        calls.push([name, input]);
        return result;
      },
    });
    await expect(backend.parkRobots("demo", { serialNumbers: ["r1"] })).resolves.toEqual(result);
    expect(calls).toEqual([["demo", { serialNumbers: ["r1"] }]]);

    const bare = createMemoryBackend(site);
    await expect(bare.parkRobots("demo", { serialNumbers: ["r1"] })).rejects.toThrow(/no dispatcher/);
  });

  test("tasks delegate to actions, or fail clearly", async () => {
    const calls: string[] = [];
    const queued: TaskView[] = [
      { id: "task-1", pickup: "a", dropoff: "b", status: "queued", createdAt: 1 },
    ];
    const backend = createMemoryBackend(site, {
      submitTask: async (name, arg) => {
        calls.push(`submit:${name}:${arg.pickup}->${arg.dropoff}`);
        return { taskId: "task-1" };
      },
      listTasks: async (name) => {
        calls.push(`list:${name}`);
        return queued;
      },
      withdrawTask: async (name, taskId) => {
        calls.push(`withdraw:${name}:${taskId}`);
      },
    });
    await expect(backend.submitTask("demo", { pickup: "a", dropoff: "b" })).resolves.toEqual({
      taskId: "task-1",
    });
    await expect(backend.listTasks("demo")).resolves.toEqual(queued);
    await expect(backend.withdrawTask("demo", "task-1")).resolves.toBeUndefined();
    expect(calls).toEqual(["submit:demo:a->b", "list:demo", "withdraw:demo:task-1"]);

    const bare = createMemoryBackend(site);
    await expect(bare.submitTask("demo", { pickup: "a", dropoff: "b" })).rejects.toThrow(/no dispatcher/);
    await expect(bare.listTasks("demo")).rejects.toThrow(/no dispatcher/);
    await expect(bare.withdrawTask("demo", "task-1")).rejects.toThrow(/no dispatcher/);
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
