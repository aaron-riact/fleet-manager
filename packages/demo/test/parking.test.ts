import { describe, expect, test } from "bun:test";
import { freeSpot } from "../src/parking.js";

const spots = [
  { id: "p1", x: 0, y: 0 },
  { id: "p2", x: 10, y: 0 },
];

describe("freeSpot", () => {
  test("nearest free spot wins", () => {
    expect(freeSpot(spots, new Map(), { x: 9, y: 1 })?.id).toBe("p2");
    expect(freeSpot(spots, new Map([["p2", "r1"]]), { x: 9, y: 1 })?.id).toBe("p1");
  });

  test("none free, or no position", () => {
    expect(freeSpot(spots, new Map([["p1", "a"], ["p2", "b"]]))).toBeUndefined();
    expect(freeSpot(spots, {})?.id).toBe("p1");
    expect(freeSpot([], new Map())?.id).toBeUndefined();
  });
});
