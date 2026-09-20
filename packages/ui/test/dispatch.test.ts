import { describe, expect, test } from "bun:test";
import { buildTour } from "../src/dispatch.js";

const nodes = [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 10, y: 0 },
  { id: "c", x: 10, y: 8 },
];
const links = [
  { source: "a", destination: "b", bidirectional: true },
  { source: "b", destination: "c" },
];

describe("station tours stay on the network", () => {
  test("node path between geometric endpoints", () => {
    expect(buildTour(nodes, links, { x: 0, y: 0 }, { x: 10, y: 8 })?.map((w) => w.nodeId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(buildTour(nodes, links, { x: 0, y: 0 }, { x: 0, y: 0 })?.map((w) => w.nodeId)).toEqual(["a"]);
    expect(buildTour([], links, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeUndefined();
    expect(buildTour(nodes, links, { x: 10, y: 8 }, { x: 0, y: 0 })).toBeUndefined();
  });

  test("authored entries beat geometric nearest", () => {
    // drop pose sits on "c", but the map hangs this station off "a"
    expect(
      buildTour(nodes, links, { x: 0, y: 0 }, { x: 10, y: 8, entry: "a" })?.map((w) => w.nodeId),
    ).toEqual(["a"]);
    // unknown entry ids fall back to geometry instead of failing
    expect(
      buildTour(nodes, links, { x: 0, y: 0 }, { x: 10, y: 8, entry: "ghost" })?.map((w) => w.nodeId),
    ).toEqual(["a", "b", "c"]);
  });

  test("a robot fix starts the tour at the robot, routed on-graph", () => {
    // robot near "b" touring a->b: reaches back along the network (b, a,
    // b), so the only free-drive leg is the short approach hop
    expect(
      buildTour(nodes, links, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 9, y: 0 })?.map((w) => w.nodeId),
    ).toEqual(["b", "a", "b"]);
    // a robot on a one-way dead end cannot route anywhere: honest undefined
    expect(buildTour(nodes, links, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 })).toBeUndefined();
  });
});