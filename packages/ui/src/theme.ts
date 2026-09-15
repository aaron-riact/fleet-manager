/**
 * Fleet Manager visual language. Single source of truth for color,
 * surface, and status mapping — App, FleetMap, and the demo's
 * Director panel all read from here so the two frontends cannot drift.
 */
export const theme = {
  bg: "#070b12",
  bgRaised: "#0d1420",
  glass: "rgba(17, 24, 38, 0.72)",
  border: "#232f45",
  borderSoft: "#1a2436",
  text: "#e8eef7",
  textDim: "#8b98ad",
  textFaint: "#5a6578",
  accent: "#2f81f7",
  ok: "#3fb950",
  warn: "#e3b341",
  hold: "#f0883e",
  bad: "#f85149",
  radius: 14,
  font: "system-ui, -apple-system, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

export type RobotStatus = "driving" | "waiting" | "idle" | "offline";

export interface RobotSnapshot {
  serialNumber: string;
  x: number;
  y: number;
  driving: boolean;
  /** First unreleased node id in its active order, if any. */
  waitingOn?: string;
  /** Node ids it currently owns (locks snapshot). */
  holding?: string[];
}

/** One-word robot state for dots, cards, and the fleet bar. */
export function robotStatus(robot: RobotSnapshot): RobotStatus {
  if (!Number.isFinite(robot.x) || !Number.isFinite(robot.y)) return "offline";
  if (robot.driving) return "driving";
  if (robot.waitingOn !== undefined) return "waiting";
  return "idle";
}

export function statusColor(status: RobotStatus): string {
  switch (status) {
    case "driving":
      return theme.ok;
    case "waiting":
      return theme.warn;
    case "idle":
      return theme.textDim;
    case "offline":
      return theme.bad;
  }
}
