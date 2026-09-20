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
  /** Trolley slot: stance pose projected along its facing. */
  x: number;
  y: number;
  /** Facing the robot holds while docked. */
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
 * Where a station's trolley waits: the stance projected ahead along its
 * facing. Shared by the maneuver (dock params) and the map markers so the
 * robot drives to the rectangle it sees.
 */
export function stationDock(
  site: Site,
  stationId: string,
  role: "pickup" | "dropoff",
): StationDock | undefined {
  const stance = stanceFor(site, stationId, role);
  if (!stance) return undefined;
  return {
    station: stance.station,
    x: stance.x + Math.cos(stance.theta) * TROLLEY_AHEAD_M,
    y: stance.y + Math.sin(stance.theta) * TROLLEY_AHEAD_M,
    theta: stance.theta,
  };
}

/** Entry graph node a station's tour arrives at, if it has one. */
export function stationEntry(site: Site, stationId: string): string | undefined {
  return (site.locations ?? []).find((l) => l.id === stationId)?.entry;
}

/** Stations whose entry is this node and that are posed for the role. */
function stationsAt(site: Site, nodeId: string, role: "pickup" | "dropoff"): Stance[] {
  const out: Stance[] = [];
  for (const loc of site.locations ?? []) {
    if (loc.entry !== nodeId) continue;
    const stance = stanceFor(site, loc.id, role);
    if (stance) out.push(stance);
  }
  return out;
}

const FULL_TURN_S = Math.PI / TROLLEY_TURN_RPS;

export function pickAttachments(site: Site, nodeId: string): NodeActionAttachment[] {
  const node = site.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return stationsAt(site, nodeId, "pickup")
    .map((stance) => ({ stance, dock: stationDock(site, stance.station, "pickup")! }))
    .map(({ stance, dock }) => {
      // Drive to the triangle, face its pointing, drive to the trolley,
      // match its angle — worst case two half-turns plus the drive.
      const duration =
        Math.hypot(dock.x - node.x, dock.y - node.y) / TROLLEY_DRIVE_MPS +
        2 * FULL_TURN_S +
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

export function dropAttachments(site: Site, nodeId: string): NodeActionAttachment[] {
  const node = site.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return stationsAt(site, nodeId, "dropoff")
    .map((stance) => ({ stance, dock: stationDock(site, stance.station, "dropoff")! }))
    .map(({ stance, dock }) => {
      // Drive to the slot, face the triangle, exit 1m toward it.
      const duration =
        Math.hypot(dock.x - node.x, dock.y - node.y) / TROLLEY_DRIVE_MPS +
        2 * FULL_TURN_S +
        1 / TROLLEY_DRIVE_MPS +
        TROLLEY_DURATION_MARGIN_S;
      return {
        actionType: DROP_TROLLEY,
        actionParameters: [
          { key: "station", value: stance.station },
          { key: "stanceX", value: stance.x },
          { key: "stanceY", value: stance.y },
          { key: "stanceTheta", value: stance.theta },
          { key: "dockX", value: dock.x },
          { key: "dockY", value: dock.y },
          { key: "dockTheta", value: dock.theta },
          { key: "duration", value: duration },
        ],
        blockingType: "HARD",
      };
    });
}
