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
    { id: "bay", entry: "b", pickPose: { x: 5, y: 0 }, dropPose: { x: 5, y: -1 } },
    { id: "depot", entry: "a", pickPose: { x: -1, y: 0 }, dropPose: { x: -1, y: -1, theta: -Math.PI / 2 } },
    { id: "solo", entry: "c", pickPose: { x: 6, y: 0 } },
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
  test("slot centers on the drop diamond, long side facing the stances", () => {
    // bay drop is at (5, -1); segment runs due south so the long side
    // faces east-west.
    const dock = stationDock(site, "bay")!;
    expect(dock.station).toBe("bay");
    expect(dock.x).toBeCloseTo(5, 9);
    expect(dock.y).toBeCloseTo(-1, 9);
    expect(dock.theta).toBeCloseTo(0, 9);
  });

  test("single-pose stations fall back to facing-projected", () => {
    // solo pick (6, 0) off entry c (8, 0) faces west: dock at (5, 0),
    // long side north-south.
    const dock = stationDock(site, "solo")!;
    expect(dock.station).toBe("solo");
    expect(dock.x).toBeCloseTo(5, 9);
    expect(dock.y).toBeCloseTo(0, 9);
    expect(dock.theta).toBeCloseTo(Math.PI / 2, 9);
  });

  test("unknown station yields no dock", () => {
    expect(stationDock(site, "ghost")).toBeUndefined();
  });
});

describe("attachments name one station", () => {
  // Two stations on one entry node, like lounge and window on coalescent.
  const shared: Site = {
    name: "shared-entry",
    nodes: [{ id: "n", x: 0, y: 0 }],
    links: [],
    locations: [
      { id: "left", entry: "n", pickPose: { x: -1, y: 1 }, dropPose: { x: -2, y: 1 } },
      { id: "right", entry: "n", pickPose: { x: 1, y: 1 }, dropPose: { x: 2, y: 1 } },
    ],
  } as Site;
  const stationOf = (a: { actionParameters?: Array<{ key: string; value: unknown }> }) =>
    a.actionParameters?.find((p) => p.key === "station")?.value;

  test("a pick or drop at a shared entry works the chosen station only", () => {
    // Built per node, a drop at "right" also dropped at "left": the first
    // action put the trolley down at the wrong station and the second
    // HARD-failed with nothing left to drop.
    expect(pickAttachments(shared, "right").map(stationOf)).toEqual(["right"]);
    expect(dropAttachments(shared, "left").map(stationOf)).toEqual(["left"]);
  });

  test("a station not posed for the role, or unknown, yields no work", () => {
    expect(dropAttachments(site, "solo")).toEqual([]);
    expect(pickAttachments(shared, "nowhere")).toEqual([]);
  });
});

describe("trolley pick and drop", () => {
  test("pick drives under the trolley; drop sets it down and exits clear", async () => {
    const world = new TrolleyWorld();
    world.seed("bay", "trolley-1", 0);
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
          { nodeId: "b", x: 4, y: 0, actions: pickAttachments(site, "bay") },
          { nodeId: "c", x: 8, y: 0 },
        ],
      );

      // The maneuver left the node for the slot on the drop diamond
      // at (5, -1), then drove on laden toward c.
      const positions = seen.map((s) => s.agvPosition).filter((p) => p !== undefined);
      expect(Math.min(...positions.map((p) => p!.y!))).toBeLessThan(-0.9);
      const ladenEnRoute = seen.filter(
        (s) =>
          (s.loads ?? []).length > 0 &&
          s.agvPosition?.x !== undefined &&
          s.agvPosition.x > 5.5,
      );
      expect(ladenEnRoute.length).toBeGreaterThan(0);
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
          { nodeId: "a", x: 0, y: 0, actions: dropAttachments(site, "depot") },
        ],
      );

      expect(world.trolleyAt("depot")).toBe("trolley-1");
      expect(world.carrierOf("trolley-1")).toBeUndefined();
      // Parked with its long side facing the depot stances.
      expect(world.trolleyPose("depot")?.theta).toBeCloseTo(0, 5);
      const after = seen.slice(seen.indexOf(last) + 1);
      const dropPositions = after.map((s) => s.agvPosition).filter((p) => p !== undefined);
      // Slot on the depot diamond at (-1, -1); detached there, faced
      // the pick triangle (north) and exited 1m onto it.
      expect(Math.min(...dropPositions.map((p) => p!.y!))).toBeLessThan(-0.9);
      const dropEnd = dropPositions[dropPositions.length - 1]!;
      expect(dropEnd.x).toBeCloseTo(-1, 0);
      expect(dropEnd.y).toBeCloseTo(0, 0);
      expect(dropEnd.theta).toBeCloseTo(Math.PI / 2, 1);
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
            { nodeId: "b", x: 4, y: 0, actions: pickAttachments(site, "bay") },
          ],
        ),
      ).rejects.toThrow(/no trolley/);
    } finally {
      await fleet.stop();
    }
  }, 60_000);
});
