import type { NodeActionAttachment, Site } from "@fleet-manager/core";
import {
  DROP_TROLLEY,
  PICK_TROLLEY,
  TROLLEY_AHEAD_M,
  TROLLEY_DRIVE_MPS,
  TROLLEY_DURATION_MARGIN_S,
  TROLLEY_TURN_RPS,
} from "./adapter.js";

export interface StationDock {
  station: string;
  /** Trolley slot: centered on the drop diamond (pick stance when dropless). */
  x: number;
  y: number;
  /**
   * Long-axis angle: perpendicular to the pick→drop segment, so the side
   * faces the robot standing at either stance looking at the slot.
   */
  theta: number;
}

interface Stance {
  station: string;
  entry?: string;
  x: number;
  y: number;
  theta: number;
}

/** Facing at a stance: its theta, else entry-ward (stance faces away from entry). */
function facing(site: Site, entry: string | undefined, x: number, y: number, theta: number | undefined): number {
  if (theta !== undefined && Number.isFinite(theta)) return theta;
  const node = entry === undefined ? undefined : site.nodes.find((n) => n.id === entry);
  return node === undefined ? 0 : Math.atan2(y - node.y, x - node.x);
}

/** Station stance (the triangle the robot drives to) for a role, if posed. */
function stanceFor(site: Site, stationId: string, role: "pickup" | "dropoff"): Stance | undefined {
  const loc = (site.locations ?? []).find((l) => l.id === stationId);
  const pose = loc === undefined ? undefined : role === "pickup" ? loc.pickPose : loc.dropPose;
  if (!loc || !pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return undefined;
  return {
    station: loc.id,
    entry: loc.entry,
    x: pose.x,
    y: pose.y,
    theta: facing(site, loc.entry, pose.x, pose.y, pose.theta),
  };
}

/**
 * Where a station's trolley waits: centered on the drop diamond, long
 * side facing the stances. The segment angle comes straight from the
 * pick→drop coords (perpendicular); single-pose stations fall back to
 * facing-perpendicular. Shared by the maneuver (dock params) and the map
 * markers so the robot drives to the rectangle it sees.
 */
export function stationDock(site: Site, stationId: string): StationDock | undefined {
  const pick = stanceFor(site, stationId, "pickup");
  const drop = stanceFor(site, stationId, "dropoff");
  if (!pick && !drop) return undefined;
  // Rectangles are π-symmetric: normalize so equivalent angles compare
  // (and test) equal.
  const norm = (t: number): number => {
    let v = t % Math.PI;
    if (v < 0) v += Math.PI;
    return v;
  };
  if (pick && drop) {
    return {
      station: pick.station,
      x: drop.x,
      y: drop.y,
      theta: norm(Math.atan2(drop.y - pick.y, drop.x - pick.x) + Math.PI / 2),
    };
  }
  const a = (pick ?? drop)!;
  return {
    station: a.station,
    x: a.x + Math.cos(a.theta) * TROLLEY_AHEAD_M,
    y: a.y + Math.sin(a.theta) * TROLLEY_AHEAD_M,
    theta: norm(a.theta + Math.PI / 2),
  };
}

/** Entry graph node a station's tour arrives at, if it has one. */
export function stationEntry(site: Site, stationId: string): string | undefined {
  return (site.locations ?? []).find((l) => l.id === stationId)?.entry;
}

/** Ids of the stations whose entry is this node. */
export function stationsAtNode(site: Site, nodeId: string): string[] {
  return (site.locations ?? []).filter((l) => l.entry === nodeId).map((l) => l.id);
}

/** The station's entry node, when it is posed for the role. */
function workAt(site: Site, stationId: string, role: "pickup" | "dropoff") {
  const stance = stanceFor(site, stationId, role);
  const entry = stationEntry(site, stationId);
  const node = entry === undefined ? undefined : site.nodes.find((n) => n.id === entry);
  return stance && node ? { stance, node } : undefined;
}

const FULL_TURN_S = Math.PI / TROLLEY_TURN_RPS;

/**
 * Pick work for one station, to ride its entry node. Built per station,
 * not per node: two stations can share an entry, and work for both would
 * run at whichever the robot reached first.
 */
export function pickAttachments(site: Site, stationId: string): NodeActionAttachment[] {
  const at = workAt(site, stationId, "pickup");
  if (!at) return [];
  const { node } = at;
  return [at.stance]
    .map((stance) => ({ stance, dock: stationDock(site, stance.station)! }))
    .map(({ stance, dock }) => {
      // Drive to the triangle, face its pointing, drive to the trolley,
      // match its angle, attach, face onward — worst case three
      // half-turns plus the drive.
      const duration =
        Math.hypot(dock.x - node.x, dock.y - node.y) / TROLLEY_DRIVE_MPS +
        3 * FULL_TURN_S +
        TROLLEY_DURATION_MARGIN_S;
      return {
        actionType: PICK_TROLLEY,
        actionParameters: [
          { key: "station", value: stance.station },
          { key: "stanceX", value: stance.x },
          { key: "stanceY", value: stance.y },
          { key: "stanceTheta", value: stance.theta },
          { key: "dockX", value: dock.x },
          { key: "dockY", value: dock.y },
          { key: "duration", value: duration },
        ],
        blockingType: "HARD",
      };
    });
}

/** Drop work for one station, to ride its entry node (see pickAttachments). */
export function dropAttachments(site: Site, stationId: string): NodeActionAttachment[] {
  const at = workAt(site, stationId, "dropoff");
  if (!at) return [];
  const { node } = at;
  return [at.stance]
    .map((stance) => ({
      stance: stanceFor(site, stance.station, "pickup") ?? stance,
      dock: stationDock(site, stance.station)!,
    }))
    .map(({ stance, dock }) => {
      // Drive to the slot, detach, face the pick triangle, exit toward
      // it, face onward — worst case three half-turns plus the drive.
      // The stance here is the pick triangle (exit reference), not the
      // drop diamond the slot sits on.
      const exitDist = Math.min(1, Math.hypot(stance.x - dock.x, stance.y - dock.y));
      const duration =
        Math.hypot(dock.x - node.x, dock.y - node.y) / TROLLEY_DRIVE_MPS +
        3 * FULL_TURN_S +
        exitDist / TROLLEY_DRIVE_MPS +
        TROLLEY_DURATION_MARGIN_S;
      return {
        actionType: DROP_TROLLEY,
        actionParameters: [
          { key: "station", value: stance.station },
          { key: "stanceX", value: stance.x },
          { key: "stanceY", value: stance.y },
          { key: "dockX", value: dock.x },
          { key: "dockY", value: dock.y },
          { key: "dockTheta", value: dock.theta },
          { key: "trolleyTheta", value: dock.theta },
          { key: "exitDist", value: exitDist },
          { key: "duration", value: duration },
        ],
        blockingType: "HARD",
      };
    });
}
