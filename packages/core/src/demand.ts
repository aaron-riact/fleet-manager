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
 * against unknown demand still creates the task, it just moves nothing —
 * and reports whether a unit actually moved. Withdrawing that request
 * returns a unit, so a refund without this would mint demand that was
 * never there.
 */
export function consumeDemand(
  counts: DemandCounts,
  zone: string,
): { counts: DemandCounts; took: boolean } {
  const have = counts[zone] ?? 0;
  const took = have > 0;
  return { counts: { ...counts, [zone]: took ? have - 1 : 0 }, took };
}

/** Stable snapshot for streams and boards, zones alphabetical. */
export function demandList(counts: DemandCounts): ZoneDemand[] {
  return Object.entries(counts)
    .map(([zone, demand]) => ({ zone, demand }))
    .sort((a, b) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0));
}
