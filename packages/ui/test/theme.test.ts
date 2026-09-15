import { describe, expect, test } from "bun:test";
import { robotStatus, statusColor, theme } from "../src/theme.js";

describe("robotStatus", () => {
  test("maps pose and order state to one word", () => {
    expect(robotStatus({ serialNumber: "r", x: 1, y: 2, driving: true })).toBe("driving");
    expect(robotStatus({ serialNumber: "r", x: 1, y: 2, driving: false, waitingOn: "east" })).toBe("waiting");
    expect(robotStatus({ serialNumber: "r", x: 1, y: 2, driving: false })).toBe("idle");
    expect(robotStatus({ serialNumber: "r", x: Number.NaN, y: 2, driving: false })).toBe("offline");
  });

  test("every status has a theme color", () => {
    for (const status of ["driving", "waiting", "idle", "offline"] as const) {
      expect(typeof statusColor(status)).toBe("string");
      expect(statusColor(status)).toMatch(/^#/);
    }
    expect(statusColor("waiting")).toBe(theme.warn);
    expect(statusColor("driving")).toBe(theme.ok);
  });
});
