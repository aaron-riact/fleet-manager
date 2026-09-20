import type { MapNode, MapUnderlay, Site, SiteLocation, SitePose } from "@fleet-manager/core";
import { theme } from "./theme";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bounding box of everything the map draws (y-up meters) — nodes plus
 * parking spots and station poses. Nodes alone would clip anything that
 * sits off the graph, which is exactly where stations tend to be.
 */
export function boundsOf(
  site: Pick<Site, "nodes"> & Partial<Pick<Site, "parking" | "locations" | "underlay">>,
): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of site.nodes) include(n.x, n.y);
  for (const p of site.parking ?? []) include(p.x, p.y);
  for (const l of site.locations ?? []) {
    if (l.pickPose) include(l.pickPose.x, l.pickPose.y);
    if (l.dropPose) include(l.dropPose.x, l.dropPose.y);
  }
  // The backdrop must never be clipped by the graph it sits under.
  if (site.underlay) {
    include(site.underlay.minX, site.underlay.minY);
    include(site.underlay.maxX, site.underlay.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/** Underlay image rectangle in SVG coords (y-down). Pure, tested. */
export function underlayRect(underlay: MapUnderlay, bounds: Bounds): { x: number; y: number; width: number; height: number } {
  const topLeft = toSvg(underlay.minX, underlay.maxY, bounds);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: underlay.maxX - underlay.minX,
    height: underlay.maxY - underlay.minY,
  };
}

/** Map meters (y-up) to SVG coords (y-down), origin at bounds min. */
export function toSvg(x: number, y: number, bounds: Bounds): { x: number; y: number } {
  return { x: x - bounds.minX, y: bounds.maxY - y };
}

/**
 * SVG-space unit vector for a world heading (radians, CCW in y-up
 * meters). The y component flips with the projection. Pure, tested.
 */
export function headingVector(theta: number): { dx: number; dy: number } {
  return { dx: Math.cos(theta), dy: -Math.sin(theta) };
}

/** viewBox string with padding, for `<svg viewBox>`. */
export function viewBoxFor(bounds: Bounds, pad = 1): string {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  return `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`;
}

const NICE_STEPS = [1, 2, 5, 10] as const;

/** Nice-number grid spacing (~12 cells across). Pure, tested. */
export function gridSpacing(widthMeters: number): number {
  const target = Math.max(widthMeters / 12, 0.5);
  const pow = 10 ** Math.floor(Math.log10(target));
  for (const m of NICE_STEPS) if (m * pow >= target) return m * pow;
  return 10 * pow;
}

/** World-coordinate grid lines snapped to spacing multiples. Pure, tested. */
export function gridLines(bounds: Bounds, spacing: number): { vertical: number[]; horizontal: number[] } {
  const vertical: number[] = [];
  for (let x = Math.ceil(bounds.minX / spacing) * spacing; x <= bounds.maxX + 1e-9; x += spacing) {
    vertical.push(Math.round(x * 1e9) / 1e9);
  }
  const horizontal: number[] = [];
  for (let y = Math.ceil(bounds.minY / spacing) * spacing; y <= bounds.maxY + 1e-9; y += spacing) {
    horizontal.push(Math.round(y * 1e9) / 1e9);
  }
  return { vertical, horizontal };
}

/** Nice-number scale bar length, at most a fifth of the view. Pure, tested. */
export function scaleBarLength(widthMeters: number): number {
  const target = widthMeters / 5;
  const pow = 10 ** Math.floor(Math.log10(target));
  for (const m of [5, 2, 1] as const) if (m * pow <= target) return m * pow;
  return pow;
}

/** Index nodes by id for link resolution. */
export function indexNodes(nodes: MapNode[]): Map<string, MapNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

const ZONE_PALETTE = [theme.accent, theme.ok, theme.warn, theme.hold] as const;

/** Deterministic color per zone name (stable across renders). */
export function zoneColor(zone: string | undefined): string {
  if (!zone) return theme.textDim;
  let hash = 0;
  for (let i = 0; i < zone.length; i++) {
    hash = (hash * 31 + zone.charCodeAt(i)) >>> 0;
  }
  return ZONE_PALETTE[hash % ZONE_PALETTE.length]!;
}

/**
 * The poses a station is drawn at. A station that picks and drops in
 * different places gets a marker for each; one that uses a single pose
 * for both gets one marker, not two stacked on top of each other.
 */
export function stationPoses(
  location: SiteLocation,
): Array<{ kind: "pick" | "drop"; pose: SitePose }> {
  const { pickPose, dropPose } = location;
  if (pickPose && dropPose) {
    if (pickPose.x === dropPose.x && pickPose.y === dropPose.y) {
      return [{ kind: "pick", pose: pickPose }];
    }
    return [
      { kind: "pick", pose: pickPose },
      { kind: "drop", pose: dropPose },
    ];
  }
  if (pickPose) return [{ kind: "pick", pose: pickPose }];
  if (dropPose) return [{ kind: "drop", pose: dropPose }];
  return [];
}

/** Group station locations by zone (unzoned under ""). */
export function groupByZone(locations: SiteLocation[]): Map<string, SiteLocation[]> {
  const groups = new Map<string, SiteLocation[]>();
  for (const location of locations) {
    const key = location.zone ?? "";
    const list = groups.get(key) ?? [];
    list.push(location);
    groups.set(key, list);
  }
  return groups;
}
