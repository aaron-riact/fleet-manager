import { describe, expect, test } from "bun:test";
import { Topic } from "vda-5050-lib";
import type { State } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import type { Site } from "@fleet-manager/core";
import { Fleet } from "@fleet-manager/vda";
import { bootFleet } from "../src/fleet.js";
import { TrolleyAdapter } from "../src/trolley/adapter.js";
import { dropAttachments, pickAttachments, stationDock } from "../src/trolley/attachments.js";
import { TrolleyWorld } from "../src/trolley/world.js";

const site: Site = {
  name: "trolley-test",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 4, y: 0 },
  ],
  links: [{ source: "a", destination: "b", bidirectional: true }],
  locations: [
    { id: "bay", entry: "b", pickPose: { x: 5, y: 0 }, dropPose: { x: 5, y: 0 } },
    { id: "depot", entry: "a", pickPose: { x: -1, y: 0 }, dropPose: { x: -1, y: 0, theta: Math.PI } },
  ],
} as Site;

const maker = "RobotCompany";

describe("trolley world", () => {
  test("seed, attach, and place move a trolley station to robot to station", () => {
    const world = new TrolleyWorld();
    world.seed("bay", "trolley-1");
    expect(world.trolleyAt("bay")).toBe("trolley-1");
    world.attach("trolley-1", "r1");
    expect(world.trolleyAt("bay")).toBeUndefined();
    expect(world.carrierOf("trolley-1")).toBe("r1");
    world.place("depot", "trolley-1");
    expect(world.trolleyAt("depot")).toBe("trolley-1");
    expect(world.carrierOf("trolley-1")).toBeUndefined();
  });

  test("double occupancy fails fast", () => {
    const world = new TrolleyWorld();
    world.seed("bay", "trolley-1");
    expect(() => world.seed("bay", "trolley-2")).toThrow(/already holds/);
    world.attach("trolley-1", "r1");
    expect(() => world.attach("trolley-1", "r2")).toThrow(/already carried/);
  });
});

describe("stationDock", () => {
  test("projects the stance along its facing", () => {
    // depot dropPose (-1, 0, theta π) faces west: trolley waits at (-2, 0).
    const dock = stationDock(site, "depot", "dropoff")!;
    expect(dock.station).toBe("depot");
    expect(dock.x).toBeCloseTo(-2, 9);
    expect(dock.y).toBeCloseTo(0, 9);
    expect(dock.theta).toBe(Math.PI);
  });

  test("poses without theta face away from the entry node", () => {
    // bay pickPose (5, 0) off entry b (4, 0): faces east, dock at (6, 0).
    expect(stationDock(site, "bay", "pickup")).toMatchObject({ station: "bay", x: 6, y: 0, theta: 0 });
  });

  test("unknown station or missing pose yields no dock", () => {
    expect(stationDock(site, "ghost", "pickup")).toBeUndefined();
  });
});

describe("trolley pick and drop", () => {
  test("pick drives under the trolley; drop sets it down and exits clear", async () => {
    const world = new TrolleyWorld();
    world.seed("bay", "trolley-1");
    const fleet = await bootFleet({
      robots: [{ manufacturer: maker, serialNumber: "t1", x: 0, y: 0 }],
      adapterType: TrolleyAdapter,
      adapterOptions: { world },
    });
    const seen: State[] = [];
    try {
      const master = fleet.master as unknown as {
        subscribeTopic(t: Topic, s: object, h: (o: State) => void): Promise<string>;
      };
      await master.subscribeTopic(Topic.State, { manufacturer: maker, serialNumber: "t1" }, (o) => void seen.push(o));
      const svc = new Fleet(fleet.master, buildLocks(site), {});

      await svc.dispatch(
        { manufacturer: maker, serialNumber: "t1" },
        [
          { nodeId: "a", x: 0, y: 0 },
          { nodeId: "b", x: 4, y: 0, actions: pickAttachments(site, "b") },
        ],
      );

      // The maneuver drove off the node to the dock: stance (5, 0)
      // projected 1m along its facing (entry-ward fallback theta 0).
      const positions = seen.map((s) => s.agvPosition).filter((p) => p !== undefined);
      expect(Math.max(...positions.map((p) => p!.x))).toBeGreaterThan(5.5);
      const statuses = seen.flatMap((s) => (s.actionStates ?? []).map((a) => `${a.actionType}:${a.actionStatus}`));
      expect(statuses).toContain("pickTrolley:RUNNING");
      expect(statuses).toContain("pickTrolley:FINISHED");
      const last = seen[seen.length - 1]!;
      expect(last.loads?.map((l) => l.loadId)).toEqual(["trolley-1"]);
      expect(world.carrierOf("trolley-1")).toBe("t1");

      await svc.dispatch(
        { manufacturer: maker, serialNumber: "t1" },
        [
          { nodeId: "b", x: 4, y: 0 },
          { nodeId: "a", x: 0, y: 0, actions: dropAttachments(site, "a") },
        ],
      );

      expect(world.trolleyAt("depot")).toBe("trolley-1");
      expect(world.carrierOf("trolley-1")).toBeUndefined();
      const after = seen.slice(seen.indexOf(last) + 1);
      const dropPositions = after.map((s) => s.agvPosition).filter((p) => p !== undefined);
      // Dock is stance (-1, 0) projected along theta π to (-2, 0); swung
      // 90° and exited, so y climbs while x stays docked.
      expect(Math.min(...dropPositions.map((p) => p!.x))).toBeLessThan(-1.5);
      expect(Math.max(...dropPositions.map((p) => Math.abs(p!.y)))).toBeGreaterThan(0.5);
      const dropStatuses = after.flatMap((s) => (s.actionStates ?? []).map((a) => `${a.actionType}:${a.actionStatus}`));
      expect(dropStatuses).toContain("dropTrolley:FINISHED");
      expect(seen[seen.length - 1]!.loads ?? []).toEqual([]);
    } finally {
      await fleet.stop();
    }
  }, 90_000);

  test("pick at an empty station fails the order instead of driving on", async () => {
    const world = new TrolleyWorld();
    const fleet = await bootFleet({
      robots: [{ manufacturer: maker, serialNumber: "t2", x: 0, y: 0 }],
      adapterType: TrolleyAdapter,
      adapterOptions: { world },
    });
    try {
      const svc = new Fleet(fleet.master, buildLocks(site), {});
      await expect(
        svc.dispatch(
          { manufacturer: maker, serialNumber: "t2" },
          [
            { nodeId: "a", x: 0, y: 0 },
            { nodeId: "b", x: 4, y: 0, actions: pickAttachments(site, "b") },
          ],
        ),
      ).rejects.toThrow(/no trolley/);
    } finally {
      await fleet.stop();
    }
  }, 60_000);
});
