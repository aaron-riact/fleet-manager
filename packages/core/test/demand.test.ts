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
    expect(consumeDemand({ dock: 2 }, "dock")).toEqual({ counts: { dock: 1 }, took: true });
    expect(consumeDemand({ dock: 1 }, "dock")).toEqual({ counts: { dock: 0 }, took: true });
    // requesting against unknown demand still creates the task
    expect(consumeDemand({}, "dock")).toEqual({ counts: { dock: 0 }, took: false });
    expect(consumeDemand({ dock: 0 }, "dock")).toEqual({ counts: { dock: 0 }, took: false });
  });

  test("a request that took nothing has nothing to give back", () => {
    // Request against a zone showing zero, then withdraw it. Refunding
    // what was never taken would put demand on the board that nobody
    // signalled, breaking the sum this module exists to keep.
    const taken = consumeDemand({ dock: 0 }, "dock");
    expect(taken.took).toBe(false);
    const refunded = taken.took ? addDemand(taken.counts, "dock", 1) : taken.counts;
    expect(refunded).toEqual({ dock: 0 });

    // Where a unit was taken, the round trip is lossless.
    const real = consumeDemand({ dock: 3 }, "dock");
    expect(real.took).toBe(true);
    expect(addDemand(real.counts, "dock", 1)).toEqual({ dock: 3 });
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
