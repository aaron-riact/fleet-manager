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
    { id: "c", x: 8, y: 0 },
  ],
  links: [
    { source: "a", destination: "b", bidirectional: true },
    { source: "b", destination: "c", bidirectional: true },
  ],
  locations: [
    { id: "bay", entry: "b", pickPose: { x: 5, y: 0 }, dropPose: { x: 5, y: 0 } },
    { id: "depot", entry: "a", pickPose: { x: -1, y: 0 }, dropPose: { x: -1, y: 0, theta: Math.PI } },
  ],
} as Site;

const maker = "RobotCompany";

describe("trolley world", () => {
  test("seed, attach, and place move a trolley station to robot to station", () => {
    const world = new TrolleyWorld();
    world.seed("bay", "trolley-1", 1.2);
    expect(world.trolleyAt("bay")).toBe("trolley-1");
    expect(world.trolleyPose("bay")).toMatchObject({ id: "trolley-1", theta: 1.2 });
    world.attach("trolley-1", "r1");
    expect(world.trolleyAt("bay")).toBeUndefined();
    expect(world.carrierOf("trolley-1")).toBe("r1");
    expect(world.aboard()).toMatchObject([{ trolleyId: "trolley-1", carrier: "r1", theta: 1.2 }]);
    world.place("depot", "trolley-1", -0.5);
    expect(world.trolleyAt("depot")).toBe("trolley-1");
    expect(world.trolleyPose("depot")?.theta).toBe(-0.5);
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
      // Slow traversal: consecutive 250ms reports step 0.25m, so any
      // teleport back to a node stands out against the threshold.
      adapterOptions: { world, vehicleSpeed: 1 },
    });
    const seen: State[] = [];
    try {
      const master = fleet.master as unknown as {
        subscribeTopic(t: Topic, s: object, h: (o: State) => void): Promise<string>;
      };
      await master.subscribeTopic(Topic.State, { manufacturer: maker, serialNumber: "t1" }, (o) => void seen.push(o));
      const svc = new Fleet(fleet.master, buildLocks(site), {});

      // The pick sits mid-tour: the robot must drive on to c afterwards
      // from the dock, not teleport back to b.
      await svc.dispatch(
        { manufacturer: maker, serialNumber: "t1" },
        [
          { nodeId: "a", x: 0, y: 0 },
          { nodeId: "b", x: 4, y: 0, actions: pickAttachments(site, "b") },
          { nodeId: "c", x: 8, y: 0 },
        ],
      );

      // The maneuver drove off the node to the dock: stance (5, 0)
      // projected 1m along its facing (entry-ward fallback theta 0).
      const positions = seen.map((s) => s.agvPosition).filter((p) => p !== undefined);
      expect(Math.max(...positions.map((p) => p!.x))).toBeGreaterThan(5.5);
      // …and the tour drove on to c from the dock.
      const pickEnd = positions[positions.length - 1]!;
      expect(pickEnd.x).toBeCloseTo(8, 0);
      // No teleporting: every consecutive report steps continuously,
      // including the handoff from maneuver back to graph traversal.
      let maxStep = 0;
      for (let i = 1; i < positions.length; i++) {
        const a = positions[i - 1]!;
        const b = positions[i]!;
        maxStep = Math.max(maxStep, Math.hypot(b.x! - a.x!, b.y! - a.y!));
      }
      expect(maxStep).toBeLessThan(0.75);
      const statuses = seen.flatMap((s) => (s.actionStates ?? []).map((a) => `${a.actionType}:${a.actionStatus}`));
      expect(statuses).toContain("pickTrolley:RUNNING");
      expect(statuses).toContain("pickTrolley:FINISHED");
      const last = seen[seen.length - 1]!;
      expect(last.loads?.map((l) => l.loadId)).toEqual(["trolley-1"]);
      expect(world.carrierOf("trolley-1")).toBe("t1");

      await svc.dispatch(
        { manufacturer: maker, serialNumber: "t1" },
        [
          { nodeId: "c", x: 8, y: 0 },
          { nodeId: "b", x: 4, y: 0 },
          { nodeId: "a", x: 0, y: 0, actions: dropAttachments(site, "a") },
        ],
      );

      expect(world.trolleyAt("depot")).toBe("trolley-1");
      expect(world.carrierOf("trolley-1")).toBeUndefined();
      // Parked perpendicular to the stance facing: long side to the triangle.
      expect(world.trolleyPose("depot")?.theta).toBeCloseTo(-Math.PI / 2, 5);
      const after = seen.slice(seen.indexOf(last) + 1);
      const dropPositions = after.map((s) => s.agvPosition).filter((p) => p !== undefined);
      // Dock is stance (-1, 0) projected along theta π to (-2, 0); faced
      // back toward the triangle and exited 1m onto the stance, facing 0.
      expect(Math.min(...dropPositions.map((p) => p!.x))).toBeLessThan(-1.9);
      const dropEnd = dropPositions[dropPositions.length - 1]!;
      expect(dropEnd.x).toBeCloseTo(-1, 0);
      expect(dropEnd.theta).toBeCloseTo(0, 1);
      const dropStatuses = after.flatMap((s) => (s.actionStates ?? []).map((a) => `${a.actionType}:${a.actionStatus}`));
      expect(dropStatuses).toContain("dropTrolley:FINISHED");
      expect(seen[seen.length - 1]!.loads ?? []).toEqual([]);
    } finally {
      await fleet.stop();
    }
  }, 120_000);

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
