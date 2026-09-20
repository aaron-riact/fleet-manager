import { describe, expect, test } from "bun:test";
import { addDemand, consumeDemand, demandList } from "../src/demand.js";

describe("demand counters", () => {
  test("add accumulates, zero resets, negatives rejected", () => {
    expect(addDemand({}, "dock", 2)).toEqual({ dock: 2 });
    expect(addDemand({ dock: 2 }, "dock", 3)).toEqual({ dock: 5 });
    expect(addDemand({ dock: 5 }, "dock", 0)).toEqual({ dock: 0 });
    expect(() => addDemand({}, "dock", -1)).toThrow(/non-negative integer/);
    expect(() => addDemand({}, "dock", 1.5)).toThrow(/non-negative integer/);
  });

  test("consume decrements toward the request, flooring at zero", () => {
    // conservation: one unit of demand becomes one request
    expect(consumeDemand({ dock: 2 }, "dock")).toEqual({ dock: 1 });
    expect(consumeDemand({ dock: 1 }, "dock")).toEqual({ dock: 0 });
    // requesting against unknown demand still creates the task
    expect(consumeDemand({}, "dock")).toEqual({ dock: 0 });
    expect(consumeDemand({ dock: 0 }, "dock")).toEqual({ dock: 0 });
  });

  test("inputs are never mutated, snapshots sort alphabetical", () => {
    const counts = { zebra: 1, apple: 2 };
    addDemand(counts, "apple", 1);
    consumeDemand(counts, "zebra");
    expect(counts).toEqual({ zebra: 1, apple: 2 });
    expect(demandList({ zebra: 1, apple: 2 })).toEqual([
      { zone: "apple", demand: 2 },
      { zone: "zebra", demand: 1 },
    ]);
    expect(demandList({})).toEqual([]);
  });
});
