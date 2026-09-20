import type { NodeActionAttachment, Site } from "@fleet-manager/core";
import {
  DROP_TROLLEY,
  PICK_TROLLEY,
  TROLLEY_DRIVE_MPS,
  TROLLEY_DURATION_MARGIN_S,
  TROLLEY_TURN_RPS,
} from "./adapter.js";

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
  return stationPoses(site, nodeId, "pickup").map(({ station, x, y }) => {
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
  return stationPoses(site, nodeId, "dropoff").map(({ station, x, y, theta }) => {
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
        ...(theta === undefined ? [] : [{ key: "dockTheta", value: theta }]),
        { key: "duration", value: duration },
      ],
      blockingType: "HARD",
    };
  });
}
