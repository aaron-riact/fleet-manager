import { describe, expect, test } from "bun:test";
import { stationNode } from "../src/stations.js";
import { checkStation, checkStationPair } from "../src/tasks.js";
import type { Site } from "../src/site.js";

const site = {
  name: "stations",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
    { id: "island", x: 50, y: 50 },
  ],
  links: [{ source: "a", destination: "b", bidirectional: true }],
  locations: [
    { id: "dock", entry: "b", pickPose: { x: 11, y: 1 } },
    // no entry: resolves to the node nearest its pose
    { id: "shelf", dropPose: { x: 1, y: 1 } },
    { id: "far", entry: "island", pickPose: { x: 51, y: 51 } },
  ],
} as Site;

describe("stationNode", () => {
  test("a station resolves to its entry node", () => {
    expect(stationNode(site, "dock")).toBe("b");
  });

  test("a station without an entry resolves to the node nearest its pose", () => {
    expect(stationNode(site, "shelf")).toBe("a");
  });

  test("a node id is not a station", () => {
    // Tasks name stations; node ids are a graph detail and never resolve.
    expect(stationNode(site, "a")).toBeUndefined();
    expect(stationNode(site, "nowhere")).toBeUndefined();
  });
});

describe("station task checks", () => {
  test("checkStation names the missing or unknown station", () => {
    expect(checkStation(site, "dropoff", undefined)).toEqual({ status: 400, message: "dropoff required" });
    expect(checkStation(site, "dropoff", "a")).toEqual({
      status: 400,
      message: "dropoff must be a known station",
    });
    expect(checkStation(site, "dropoff", "dock")).toBeUndefined();
  });

  test("checkStationPair orders missing, unknown, then unroutable", () => {
    expect(checkStationPair(site, "", "dock")?.message).toBe("pickup required");
    expect(checkStationPair(site, "dock", "b")).toEqual({
      status: 400,
      message: "pickup and dropoff must be known stations",
    });
    expect(checkStationPair(site, "shelf", "far")).toEqual({
      status: 409,
      message: 'no route from "shelf" to "far"',
    });
    expect(checkStationPair(site, "shelf", "dock")).toBeUndefined();
  });
});
