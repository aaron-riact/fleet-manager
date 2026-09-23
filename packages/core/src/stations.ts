import { nearestNode } from "./plan.js";
import type { Site, SiteLocation } from "./site.js";

/** A station by id, or undefined. Node ids never match: they are not stations. */
export function findStation(site: Pick<Site, "locations">, stationId: string): SiteLocation | undefined {
  return (site.locations ?? []).find((l) => l.id === stationId);
}

/**
 * The graph node a station's work rides: its entry, else the node nearest
 * its pose (pick first). Stations are what the app speaks in; this is the
 * one place a station turns into a node, when a tour is built.
 */
export function stationNode(site: Site, stationId: string): string | undefined {
  const station = findStation(site, stationId);
  if (!station) return undefined;
  if (station.entry !== undefined) return station.entry;
  const pose = station.pickPose ?? station.dropPose!;
  return nearestNode(site, pose.x, pose.y);
}
