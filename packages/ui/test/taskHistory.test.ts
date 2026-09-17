import { describe, expect, test } from "bun:test";
import { outcomeColor, selectHistory } from "../src/TaskHistory.js";
import type { HistoryView } from "../src/backend.js";
import { theme } from "../src/theme.js";

const entry = (over: Partial<HistoryView> & { orderId: string }): HistoryView => ({
  serial: "r1",
  route: [],
  finishedAt: 0,
  outcome: "completed",
  ...over,
});

describe("selectHistory", () => {
  test("sorts newest first", () => {
    const rows = selectHistory(
      [entry({ orderId: "old", finishedAt: 100 }), entry({ orderId: "new", finishedAt: 200 })],
      "all",
    );
    expect(rows.map((r) => r.orderId)).toEqual(["new", "old"]);
  });

  test("filters by outcome without mutating the input", () => {
    const input = [
      entry({ orderId: "a", outcome: "completed", finishedAt: 1 }),
      entry({ orderId: "b", outcome: "failed", finishedAt: 2, reason: "boom" }),
      entry({ orderId: "c", outcome: "cancelled", finishedAt: 3 }),
    ];
    expect(selectHistory(input, "failed").map((r) => r.orderId)).toEqual(["b"]);
    expect(selectHistory(input, "all")).toHaveLength(3);
    expect(input.map((r) => r.orderId)).toEqual(["a", "b", "c"]);
  });
});

describe("outcomeColor", () => {
  test("maps every outcome to a distinct theme color", () => {
    expect(outcomeColor("completed")).toBe(theme.ok);
    expect(outcomeColor("cancelled")).toBe(theme.warn);
    expect(outcomeColor("failed")).toBe(theme.bad);
  });
});
