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

  test("fans pose, lock, and order events out to subscribers", () => {
    const backend = createMemoryBackend(site);
    const poses: unknown[] = [];
    const locks: unknown[] = [];
    const orders: unknown[] = [];
    const un1 = backend.watchPoses("demo", (p) => void poses.push(p));
    const un2 = backend.watchLocks("demo", (s) => void locks.push(s));
    const un3 = backend.watchOrders("demo", (o) => void orders.push(o));

    backend.emitPose({ manufacturer: "m", serialNumber: "r1", x: 1, y: 2, theta: 0, driving: false });
    backend.emitLocks({ nodeLocks: [], edgeLocks: [] });
    backend.emitOrders([]);
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);

    un1();
    un2();
    un3();
    backend.emitPose({ manufacturer: "m", serialNumber: "r1", x: 1, y: 2, theta: 0, driving: false });
    backend.emitLocks({ nodeLocks: [], edgeLocks: [] });
    backend.emitOrders([]);
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);
  });
});
