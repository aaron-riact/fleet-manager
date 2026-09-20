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
  /** Trolley spot: stance pose projected along its facing. */
  x: number;
  y: number;
  /** Facing the robot holds while docked. */
  theta: number;
}

/**
 * Where a station's trolley waits: the stance (pick/drop pose) projected
 * ahead along its facing. Poses without a theta face away from their
 * entry node. Shared by the maneuver (dock params) and the map markers
 * so the robot drives to the square it sees.
 */
export function stationDock(
  site: Site,
  stationId: string,
  role: "pickup" | "dropoff",
): StationDock | undefined {
  const loc = (site.locations ?? []).find((l) => l.id === stationId);
  const stance = loc === undefined ? undefined : role === "pickup" ? loc.pickPose : loc.dropPose;
  if (!loc || !stance || !Number.isFinite(stance.x) || !Number.isFinite(stance.y)) return undefined;
  let theta = stance.theta;
  if (theta === undefined || !Number.isFinite(theta)) {
    const entry = loc.entry === undefined ? undefined : site.nodes.find((n) => n.id === loc.entry);
    theta = entry === undefined ? 0 : Math.atan2(stance.y - entry.y, stance.x - entry.x);
  }
  return {
    station: loc.id,
    x: stance.x + Math.cos(theta) * TROLLEY_AHEAD_M,
    y: stance.y + Math.sin(theta) * TROLLEY_AHEAD_M,
    theta,
  };
}

/** Entry graph node a station's tour arrives at, if it has one. */
export function stationEntry(site: Site, stationId: string): string | undefined {
  return (site.locations ?? []).find((l) => l.id === stationId)?.entry;
}

/**
 * The trolley module's only surface to dispatch: turn a tour-end node into
 * opaque work attachments. Resolution is purely data-driven — a node is a
 * pick station when some location links it as entry and offers a pickPose,
 * a drop station likewise for dropPose. Anything else yields no work and
 * the tour stays drive-only.
 *
 * Durations generously cover the maneuver (worst-case half-turn to face
 * the dock, the drive, plus the drop's align/away/exit legs, plus margin):
 * the adapter's actual plan is shorter and holds pose until the action ends.
 */
function stationPoses(site: Site, nodeId: string, role: "pickup" | "dropoff"): Array<{ station: string; x: number; y: number; theta?: number }> {
  const node = site.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const out: Array<{ station: string; x: number; y: number; theta?: number }> = [];
  for (const loc of site.locations ?? []) {
    if (loc.entry !== nodeId) continue;
    const pose = role === "pickup" ? loc.pickPose : loc.dropPose;
    if (!pose) continue;
    out.push({ station: loc.id, x: pose.x, y: pose.y, theta: pose.theta });
  }
  return out;
}

export function pickAttachments(site: Site, nodeId: string): NodeActionAttachment[] {
  const node = site.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return stationPoses(site, nodeId, "pickup")
    .map(({ station }) => stationDock(site, station, "pickup"))
    .filter((d) => d !== undefined)
    .map(({ station, x, y }) => {
      const dist = Math.hypot(x - node.x, y - node.y);
      const duration = Math.PI / TROLLEY_TURN_RPS + dist / TROLLEY_DRIVE_MPS + TROLLEY_DURATION_MARGIN_S;
      return {
        actionType: PICK_TROLLEY,
        actionParameters: [
          { key: "station", value: station },
          { key: "dockX", value: x },
          { key: "dockY", value: y },
          { key: "duration", value: duration },
        ],
        blockingType: "HARD",
      };
    });
}

export function dropAttachments(site: Site, nodeId: string): NodeActionAttachment[] {
  const node = site.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return stationPoses(site, nodeId, "dropoff")
    .map(({ station }) => stationDock(site, station, "dropoff"))
    .filter((d) => d !== undefined)
    .map(({ station, x, y, theta }) => {
      const dist = Math.hypot(x - node.x, y - node.y);
      const duration =
        Math.PI / TROLLEY_TURN_RPS + // face the dock, worst case
        dist / TROLLEY_DRIVE_MPS +
        Math.PI / TROLLEY_TURN_RPS + // align + swing 90° away
        1 / TROLLEY_DRIVE_MPS + // default 1m exit
        TROLLEY_DURATION_MARGIN_S;
      return {
        actionType: DROP_TROLLEY,
        actionParameters: [
          { key: "station", value: station },
          { key: "dockX", value: x },
          { key: "dockY", value: y },
          { key: "dockTheta", value: theta },
          { key: "duration", value: duration },
        ],
        blockingType: "HARD",
      };
    });
}
