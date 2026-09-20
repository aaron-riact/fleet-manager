/**
 * Outstanding human-signalled demand per zone ("we need N deliveries
 * here"), independent of the task queue. Creating a request consumes one
 * unit, so counters plus requested plus in-flight tasks always sum to
 * total demand and nothing gets double-requested. Pure; retention and
 * fan-out live with the caller.
 */
export type DemandCounts = Record<string, number>;

export interface ZoneDemand {
  zone: string;
  demand: number;
}

/** Add n units to a zone; n = 0 resets it. Never negative. */
export function addDemand(counts: DemandCounts, zone: string, n: number): DemandCounts {
  if (!Number.isInteger(n) || n < 0) throw new Error("demand count must be a non-negative integer");
  const next = { ...counts };
  next[zone] = n === 0 ? 0 : (next[zone] ?? 0) + n;
  return next;
}

/**
 * Consume one unit when it becomes a request. Floors at zero — a request
 * against unknown demand still creates the task, it just moves nothing.
 */
export function consumeDemand(counts: DemandCounts, zone: string): DemandCounts {
  const next = { ...counts };
  next[zone] = Math.max(0, (next[zone] ?? 1) - 1);
  return next;
}

/** Stable snapshot for streams and boards, zones alphabetical. */
export function demandList(counts: DemandCounts): ZoneDemand[] {
  return Object.entries(counts)
    .map(([zone, demand]) => ({ zone, demand }))
    .sort((a, b) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0));
}
