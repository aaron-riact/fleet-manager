import { describe, expect, test } from "bun:test";
import { diffLocks, formatLockEvent } from "../src/lockEvents.js";

const snap = (owners: Record<string, string[]>, waiters: Record<string, string[]> = {}) => ({
  nodeLocks: Object.keys({ ...owners, ...waiters }).map((id) => ({
    id,
    owners: owners[id] ?? [],
    waiters: waiters[id] ?? [],
  })),
  edgeLocks: [],
});

describe("lockEvents", () => {
  test("reports holds, frees, and waits", () => {
    expect(diffLocks(undefined, snap({ a: ["r1"] }))).toEqual([]);
    const events = diffLocks(snap({ a: ["r1"] }), snap({ a: ["r1"], b: ["r1"] }, { b: ["r2"] }));
    expect(events).toContainEqual({ type: "locked", node: "b", by: "r1" });
    expect(events).toContainEqual({ type: "waiting", node: "b", by: "r2" });
    expect(diffLocks(snap({ b: ["r1"] }, { b: ["r2"] }), snap({ b: ["r2"] }, {}))).toContainEqual({
      type: "released",
      node: "b",
      by: "r1",
    });
  });

  test("formats readably", () => {
    expect(formatLockEvent({ type: "waiting", node: "east", by: "demo-2" })).toBe("demo-2 waits on east");
  });
});
