import { describe, expect, test } from "bun:test";
import {
  boundsOf,
  groupByZone,
  headingVector,
  indexNodes,
  stationPoses,
  toSvg,
  underlayRect,
  viewBoxFor,
  zoneColor,
} from "../src/map.js";
import { theme } from "../src/theme.js";

const nodes = [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 10, y: 8 },
];

describe("map projection", () => {
  test("bounds, y-flip, viewBox", () => {
    const b = boundsOf({ nodes });
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 8 });
    expect(toSvg(0, 0, b)).toEqual({ x: 0, y: 8 });
    expect(toSvg(10, 8, b)).toEqual({ x: 10, y: 0 });
    expect(viewBoxFor(b, 1)).toBe("-1 -1 12 10");
  });

  test("node index", () => {
    expect(indexNodes(nodes).get("b")).toEqual({ id: "b", x: 10, y: 8 });
  });

  test("heading vectors point along world headings in SVG space", () => {
    const unit = (v: { dx: number; dy: number }) => Math.hypot(v.dx, v.dy);
    // east stays east; north (+90° CCW in y-up meters) points up-screen
    const east = headingVector(0);
    expect(east.dx).toBeCloseTo(1);
    expect(east.dy).toBeCloseTo(0);
    const north = headingVector(Math.PI / 2);
    expect(north.dx).toBeCloseTo(0);
    expect(north.dy).toBeCloseTo(-1);
    for (const theta of [0, 0.7, Math.PI, -2.1]) expect(unit(headingVector(theta))).toBeCloseTo(1);
  });

  test("zone colors are deterministic and fall back gracefully", () => {
    expect(zoneColor("docks")).toBe(zoneColor("docks"));
    expect(zoneColor(undefined)).toBe(theme.textDim);
    expect([theme.accent, theme.ok, theme.warn, theme.hold] as string[]).toContain(zoneColor("bays"));
  });

  test("locations group by zone", () => {
    const groups = groupByZone([
      { id: "a", zone: "docks", pickPose: { x: 0, y: 0 } },
      { id: "b", zone: "docks", dropPose: { x: 1, y: 1 } },
      { id: "c", pickPose: { x: 2, y: 2 } },
    ]);
    expect([...groups.keys()].sort()).toEqual(["", "docks"]);
    expect(groups.get("docks")?.map((l) => l.id)).toEqual(["a", "b"]);
  });

  test("underlay rect maps the world rectangle into SVG, bounds include it", () => {
    const underlay = { uri: "hall.png", minX: -4, minY: -2, maxX: 12, maxY: 10 };
    const b = boundsOf({ nodes, underlay });
    expect(b).toEqual({ minX: -4, minY: -2, maxX: 12, maxY: 10 });
    // y-flip: world top (maxY) lands at SVG y 0
    expect(underlayRect(underlay, b)).toEqual({ x: 0, y: 0, width: 16, height: 12 });
    // without an underlay the graph sets the bounds alone
    expect(boundsOf({ nodes })).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 8 });
  });

  test("bounds cover parking and stations, not just nodes", () => {
    // a station off the graph must still be inside the drawn area,
    // otherwise its marker is clipped out of the viewBox
    const b = boundsOf({
      nodes,
      parking: [{ id: "p1", x: -3, y: 2 }],
      locations: [{ id: "dock", pickPose: { x: 4, y: 14 } }],
    });
    expect(b).toEqual({ minX: -3, minY: 0, maxX: 10, maxY: 14 });
  });

  test("a station draws one marker per distinct pose", () => {
    expect(stationPoses({ id: "a", pickPose: { x: 1, y: 1 } })).toEqual([
      { kind: "pick", pose: { x: 1, y: 1 } },
    ]);
    // same point for both: one marker, not two stacked
    expect(
      stationPoses({ id: "b", pickPose: { x: 2, y: 2 }, dropPose: { x: 2, y: 2 } }),
    ).toEqual([{ kind: "pick", pose: { x: 2, y: 2 } }]);
    expect(
      stationPoses({ id: "c", pickPose: { x: 3, y: 0 }, dropPose: { x: 9, y: 0 } }).map((s) => s.kind),
    ).toEqual(["pick", "drop"]);
  });
});
