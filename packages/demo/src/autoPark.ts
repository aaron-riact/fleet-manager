import { PARK_OCCUPIED_M, freeSpot, occupiedSpots } from "@fleet-manager/core";
import type { ParkingSpot } from "@fleet-manager/core";

export interface AutoParkPose {
  manufacturer: string;
  x: number;
  y: number;
  seenAt: number;
}

export interface SelectAutoParkTargetInput {
  spots: ParkingSpot[];
  /** Latest known pose of the robot that just finished. */
  pose: AutoParkPose | undefined;
  serialNumber: string;
  now: number;
  poseTtlMs: number;
  isBusy: (serialNumber: string) => boolean;
  /** Spot ids already targeted by other in-flight auto-parks. */
  targetedSpotIds: ReadonlySet<string>;
  /** All tracked poses (with arrival times) for occupancy. */
  allPoses: Iterable<{ x: number; y: number; seenAt: number }>;
}

/**
 * Pick where a robot should auto-park after a tour, mirroring the
 * server's post-tour behavior: nearest free spot, or undefined when
 * there is nowhere sensible to send it. Skips robots that are already
 * parked, already targeted, already busy again, or without a fresh
 * fix — and sites with no parking at all.
 */
export function selectAutoParkTarget(input: SelectAutoParkTargetInput): ParkingSpot | undefined {
  const { spots, pose, serialNumber, now, poseTtlMs, isBusy, targetedSpotIds, allPoses } = input;
  if (spots.length === 0) return undefined;
  if (
    !pose ||
    !Number.isFinite(pose.x) ||
    !Number.isFinite(pose.y) ||
    now - pose.seenAt >= poseTtlMs
  ) {
    return undefined;
  }
  if (isBusy(serialNumber)) return undefined;
  // Already sitting on a spot (e.g. a driveLoop tour that parked as
  // part of its own order): sending it elsewhere would just shuffle it.
  if (
    spots.some(
      (spot) => Math.hypot(spot.x - pose.x, spot.y - pose.y) < PARK_OCCUPIED_M,
    )
  ) {
    return undefined;
  }
  const live = [...allPoses].filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && now - p.seenAt < poseTtlMs,
  );
  return freeSpot(
    spots.filter((spot) => !targetedSpotIds.has(spot.id)),
    occupiedSpots(spots, live),
    pose,
  );
}
