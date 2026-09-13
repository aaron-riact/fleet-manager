import type { LockSnapshot, ParkingSpot } from "@fleet-manager/core";

/**
 * Pick a free parking spot, preferring the one nearest (x, y).
 * Occupancy maps spot id -> serial number.
 */
export function freeSpot(
  spots: ParkingSpot[],
  occupied: Map<string, string> | Record<string, string | undefined>,
  near?: { x: number; y: number },
): ParkingSpot | undefined {
  const isOccupied = (id: string): boolean => {
    if (occupied instanceof Map) return occupied.has(id);
    return occupied[id] !== undefined;
  };
  const free = spots.filter((s) => !isOccupied(s.id));
  if (free.length === 0) return undefined;
  if (!near || !Number.isFinite(near.x) || !Number.isFinite(near.y)) return free[0];
  return free.reduce((best, s) => {
    const d = (s.x - near.x) ** 2 + (s.y - near.y) ** 2;
    const b = (best.x - near.x) ** 2 + (best.y - near.y) ** 2;
    return d < b ? s : best;
  });
}

export interface EntryNode {
  id: string;
  x: number;
  y: number;
}

/**
 * Nearest graph node with no owners — where a new tour should enter so
 * robots spread around the loop instead of queueing at one node.
 */
export function freeEntry(
  nodes: EntryNode[],
  snapshot: LockSnapshot,
  near: { x: number; y: number },
): EntryNode | undefined {
  const owned = new Set(
    snapshot.nodeLocks.filter((n) => n.owners.length > 0).map((n) => n.id),
  );
  const free = nodes.filter((n) => !owned.has(n.id));
  if (free.length === 0) return undefined;
  return free.reduce((best, n) => {
    const d = (n.x - near.x) ** 2 + (n.y - near.y) ** 2;
    const b = (best.x - near.x) ** 2 + (best.y - near.y) ** 2;
    return d < b ? n : best;
  });
}
