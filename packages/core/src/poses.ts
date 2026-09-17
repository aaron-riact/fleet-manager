/**
 * Pose freshness. A robot that stopped reporting is not where it was
 * last seen — it is gone — so anything reasoning about where robots
 * *are* has to tell a current fix from a remembered one.
 *
 * Server, task pump and UI all need the same rule, so it lives here
 * rather than being written out three times and drifting.
 */

/** How long a pose is taken as describing where a robot currently is. */
export const DEFAULT_POSE_TTL_MS = 30_000;

/** Anything carrying the time it arrived. */
export interface Timestamped {
  seenAt: number;
}

/** Whether a pose still describes where the robot is, as of `now`. */
export function isFresh(pose: Timestamped, now: number, ttlMs: number): boolean {
  return now - pose.seenAt < ttlMs;
}

/** Poses that arrived recently enough to still describe the present. */
export function freshPoses<T extends Timestamped>(poses: Iterable<T>, now: number, ttlMs: number): T[] {
  return [...poses].filter((p) => isFresh(p, now, ttlMs));
}
