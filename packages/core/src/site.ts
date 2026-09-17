import { z } from "zod";

/**
 * Site map: graph nodes + links the fleet drives on.
 * Coordinates in meters, origin at (0,0), y-up. Frontend flips y for SVG.
 */
export const MapNodeSchema = z.object({
  id: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  theta: z.number().finite().optional(),
  radius: z.number().positive().optional(),
});

export type MapNode = z.infer<typeof MapNodeSchema>;

export const MapLinkSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
  bidirectional: z.boolean().optional(),
});

export type MapLink = z.infer<typeof MapLinkSchema>;

/**
 * Parking spots live off the graph: idle robots wait here holding no
 * locks, so through-traffic never routes around a parked robot.
 */
export const ParkingSpotSchema = z.object({
  id: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  theta: z.number().finite().optional(),
  /** Graph node this spot feeds (approach tours start here). */
  entry: z.string().min(1).optional(),
  /** Zone grouping for bulk parking (e.g. "warehouse"). */
  zone: z.string().min(1).optional(),
});

export type ParkingSpot = z.infer<typeof ParkingSpotSchema>;

/** A spot is taken when a robot sits on it (generous radius). */
export const PARK_OCCUPIED_M = 0.75;

/**
 * Pick a free parking spot, preferring the one nearest (x, y).
 * Occupancy maps spot id -> serial number.
 */
export function freeSpot(
  spots: ParkingSpot[],
  occupied: Map<string, unknown> | Record<string, unknown>,
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

/** Spot ids occupied by poses (robots sitting on them). */
export function occupiedSpots(
  spots: ParkingSpot[],
  poses: Iterable<{ x: number; y: number }>,
): Record<string, true> {
  const occupied: Record<string, true> = {};
  for (const spot of spots) {
    for (const pose of poses) {
      if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y)) continue;
      if (Math.hypot(spot.x - pose.x, spot.y - pose.y) < PARK_OCCUPIED_M) {
        occupied[spot.id] = true;
        break;
      }
    }
  }
  return occupied;
}

/**
 * Stations where work happens: pickups, drops, or both. Positions are
 * free coordinates (usually near a graph node, drawn as their own
 * marker). Zones group stations for tinting and dispatch filtering.
 */
export const SitePoseSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  theta: z.number().finite().optional(),
});

export type SitePose = z.infer<typeof SitePoseSchema>;

export const SiteLocationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    zone: z.string().min(1).optional(),
    pickPose: SitePoseSchema.optional(),
    dropPose: SitePoseSchema.optional(),
  })
  .refine((l) => l.pickPose !== undefined || l.dropPose !== undefined, {
    message: "location needs a pick pose, a drop pose, or both",
  });

export type SiteLocation = z.infer<typeof SiteLocationSchema>;

/**
 * Raster backdrop under the vector map (a scanned floor plan, a site
 * photo). World rectangle in meters, y-up; the frontend stretches the
 * image over it. The URI is operator-provided — absolute or relative to
 * whatever serves the UI — the server stores no image bytes.
 */
export const MapUnderlaySchema = z
  .object({
    uri: z.string().min(1),
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
  })
  .refine((u) => u.minX < u.maxX && u.minY < u.maxY, {
    message: "underlay needs a non-empty world rectangle (min < max)",
  });

export type MapUnderlay = z.infer<typeof MapUnderlaySchema>;

export const SiteSchema = z
  .object({
    name: z.string().min(1),
    nodes: z.array(MapNodeSchema).min(1),
    links: z.array(MapLinkSchema),
    parking: z.array(ParkingSpotSchema).optional(),
    locations: z.array(SiteLocationSchema).optional(),
    underlay: MapUnderlaySchema.optional(),
  })
  .refine(
    (site) => {
      const ids = new Set(site.nodes.map((n) => n.id));
      if (!site.links.every((l) => ids.has(l.source) && ids.has(l.destination))) return false;
      // parking lives off-graph: ids must not collide with nodes
      const parking = site.parking ?? [];
      if (!parking.every((p) => !ids.has(p.id))) return false;
      // entry links must land on known nodes
      if (!parking.every((p) => !p.entry || ids.has(p.entry))) return false;
      // locations are addressable like nodes: no id collisions anywhere
      const taken = new Set([...ids, ...parking.map((p) => p.id)]);
      for (const location of site.locations ?? []) {
        if (taken.has(location.id)) return false;
        taken.add(location.id);
      }
      return true;
    },
    { message: "links must reference known nodes; parking and location ids must be unique with known entry nodes" },
  );

export type Site = z.infer<typeof SiteSchema>;

/** Parse site JSON text (pure; I/O lives in server/CLI). */
export function parseSite(text: string): Site {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`site is not valid JSON: ${(error as Error).message}`);
  }
  return SiteSchema.parse(json);
}
