import { describe, expect, test } from "bun:test";
import { robotStatus, statusColor, theme } from "../src/theme.js";

const snap = (over: Record<string, unknown> = {}) => ({
  serialNumber: "r",
  x: 1,
  y: 2,
  driving: false,
  charging: false,
  positionInitialized: true,
  ...over,
});

describe("robotStatus", () => {
  test("maps pose and order state to one word", () => {
    expect(robotStatus({ ...snap(), driving: true })).toBe("driving");
    expect(robotStatus({ ...snap(), waitingOn: "east" })).toBe("waiting");
    expect(robotStatus(snap())).toBe("idle");
    expect(robotStatus({ ...snap(), x: Number.NaN })).toBe("offline");
  });

  test("charging wins over driving; unlocalized never shows as placed", () => {
    expect(robotStatus({ ...snap(), driving: true, charging: true })).toBe("charging");
    expect(robotStatus({ ...snap(), positionInitialized: false })).toBe("offline");
    expect(robotStatus({ ...snap(), x: Number.NaN, charging: true })).toBe("offline");
  });

  test("every status has a theme color", () => {
    for (const status of ["driving", "waiting", "charging", "idle", "offline"] as const) {
      expect(typeof statusColor(status)).toBe("string");
      expect(statusColor(status)).toMatch(/^#/);
    }
    expect(statusColor("waiting")).toBe(theme.warn);
    expect(statusColor("driving")).toBe(theme.ok);
    expect(statusColor("charging")).toBe(theme.accent);
  });
});
