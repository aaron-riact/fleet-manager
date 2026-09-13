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
});

export type ParkingSpot = z.infer<typeof ParkingSpotSchema>;

export const SiteSchema = z
  .object({
    name: z.string().min(1),
    nodes: z.array(MapNodeSchema).min(1),
    links: z.array(MapLinkSchema),
    parking: z.array(ParkingSpotSchema).optional(),
  })
  .refine(
    (site) => {
      const ids = new Set(site.nodes.map((n) => n.id));
      if (!site.links.every((l) => ids.has(l.source) && ids.has(l.destination))) return false;
      // parking lives off-graph: ids must not collide with nodes
      const parking = site.parking ?? [];
      if (!parking.every((p) => !ids.has(p.id))) return false;
      // entry links must land on known nodes
      return parking.every((p) => !p.entry || ids.has(p.entry));
    },
    { message: "links must reference known nodes; parking ids must not collide; entries must reference known nodes" },
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
