import { describe, expect, test } from "bun:test";
import { selectAutoParkTarget } from "../src/autoPark.js";
import type { ParkingSpot } from "@fleet-manager/core";

const spots: ParkingSpot[] = [
  { id: "p1", x: 1, y: 1, entry: "a" },
  { id: "p2", x: 11, y: 1, entry: "b" },
];

const NOW = 1_000_000;
const TTL = 30_000;

function setup(
  over: Partial<Parameters<typeof selectAutoParkTarget>[0]> = {},
) {
  const busy = new Set<string>();
  return {
    busy,
    input: {
      spots,
      pose: { manufacturer: "RobotCompany", x: 12, y: 0, seenAt: NOW },
      serialNumber: "r1",
      now: NOW,
      poseTtlMs: TTL,
      isBusy: (serial: string) => busy.has(serial),
      targetedSpotIds: new Set<string>(),
      allPoses: [{ x: 12, y: 0, seenAt: NOW }],
      ...over,
    },
  };
}

describe("selectAutoParkTarget", () => {
  test("picks the nearest free spot", () => {
    const { input } = setup();
    expect(selectAutoParkTarget(input)?.id).toBe("p2");
  });

  test("skips sites with no parking", () => {
    const { input } = setup({ spots: [] });
    expect(selectAutoParkTarget(input)).toBeUndefined();
  });

  test("skips missing, non-finite, or stale poses", () => {
    const { input } = setup();
    expect(selectAutoParkTarget({ ...input, pose: undefined })).toBeUndefined();
    expect(
      selectAutoParkTarget({
        ...input,
        pose: { manufacturer: "m", x: Number.NaN, y: 0, seenAt: NOW },
      }),
    ).toBeUndefined();
    expect(
      selectAutoParkTarget({
        ...input,
        pose: { manufacturer: "m", x: 12, y: 0, seenAt: NOW - TTL },
      }),
    ).toBeUndefined();
  });

  test("skips robots that are busy again or already targeted", () => {
    const { input, busy } = setup();
    busy.add("r1");
    expect(selectAutoParkTarget(input)).toBeUndefined();
    busy.clear();
    expect(
      selectAutoParkTarget({ ...input, targetedSpotIds: new Set(["p1", "p2"]) }),
    ).toBeUndefined();
  });

  test("skips robots already sitting on a spot", () => {
    const { input } = setup({
      pose: { manufacturer: "m", x: 1, y: 1, seenAt: NOW },
      allPoses: [{ x: 1, y: 1, seenAt: NOW }],
    });
    expect(selectAutoParkTarget(input)).toBeUndefined();
  });

  test("avoids physically occupied and targeted spots", () => {
    const { input } = setup({
      allPoses: [
        { x: 12, y: 0, seenAt: NOW },
        { x: 11, y: 1, seenAt: NOW },
      ],
    });
    expect(selectAutoParkTarget(input)?.id).toBe("p1");
    expect(
      selectAutoParkTarget({ ...input, targetedSpotIds: new Set(["p1"]) })?.id,
    ).toBeUndefined();
  });
});
