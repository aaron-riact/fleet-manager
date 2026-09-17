import { describe, expect, test } from "bun:test";
import { freshPoses, isFresh } from "../src/serve.js";
import type { TrackedPose } from "../src/serve.js";

const at = (serialNumber: string, seenAt: number): TrackedPose => ({
  manufacturer: "m",
  serialNumber,
  x: 0,
  y: 0,
  theta: 0,
  driving: false,
  charging: false,
  positionInitialized: true,
  eStop: false,
  fieldViolation: false,
  seenAt,
});

describe("pose freshness", () => {
  test("a pose describes the present only inside the TTL", () => {
    const pose = at("r1", 1_000);
    expect(isFresh(pose, 1_000, 30_000)).toBe(true);
    expect(isFresh(pose, 30_999, 30_000)).toBe(true);
    // exactly one TTL later it no longer says where the robot is
    expect(isFresh(pose, 31_000, 30_000)).toBe(false);
    expect(isFresh(pose, 90_000, 30_000)).toBe(false);
  });

  test("only robots still reporting are counted as present", () => {
    const poses = [at("live", 9_000), at("gone", 1_000)];
    // a robot that stopped reporting must not keep holding its spot
    expect(freshPoses(poses, 10_000, 5_000).map((p) => p.serialNumber)).toEqual(["live"]);
    expect(freshPoses(poses, 10_000, 30_000).map((p) => p.serialNumber)).toEqual(["live", "gone"]);
    expect(freshPoses([], 10_000, 30_000)).toEqual([]);
  });
});
