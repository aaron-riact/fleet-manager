import { describe, expect, test } from "bun:test";
import { buildLocks } from "../src/locks.js";
import type { NextNode } from "graferse";

const corridor = {
  name: "corridor",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 5, y: 0 },
  ],
  links: [{ source: "a", destination: "b", bidirectional: true }],
};

describe("fleet locks", () => {
  test("holder owns current+next, waiter blocks with empty grant", () => {
    const locks = buildLocks(corridor);
    const r1 = locks.lockerFor("r1").makePathLocker(["a", "b"], () => {});
    r1.arrivedAt(0);
    expect(
      locks.snapshot().nodeLocks.filter((n) => n.owners.includes("r1")).map((n) => n.id).sort(),
    ).toEqual(["a", "b"]);

    let granted: NextNode[] = [{ node: "?", index: -1 }];
    locks.lockerFor("r2").makePathLocker(["b", "a"], (next) => {
      granted = next;
    }).arrivedAt(0);
    expect(granted).toEqual([]);
    expect(locks.snapshot().nodeLocks.find((n) => n.id === "b")?.waiters).toContain("r2");
  });

  test("release wakes the waiter into the corridor", () => {
    const locks = buildLocks(corridor);
    const seen: (string | number)[][] = [];
    const r1 = locks.lockerFor("r1").makePathLocker(["a", "b"], () => {});
    r1.arrivedAt(0);
    const l2 = locks.lockerFor("r2").makePathLocker(["b", "a"], (next) => {
      seen.push(next.map((n) => n.node));
    });
    l2.arrivedAt(0);
    expect(seen).toEqual([[]]);

    r1.clearAllPathLocks();
    const owners = locks.snapshot().nodeLocks.find((n) => n.id === "b")?.owners ?? [];
    expect(owners).toContain("r2");
    expect(seen.flat()).toContain("b");
  });

  test("off-graph pseudo-nodes resolve to free locks, excluded from snapshots", () => {
    const locks = buildLocks(corridor);
    const r = locks.lockerFor("r1").makePathLocker(["__start-1", "a", "b"], () => {});
    r.arrivedAt(0);
    const snap = locks.snapshot();
    expect(snap.nodeLocks.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(snap.nodeLocks.find((n) => n.id === "a")?.owners).toEqual(["r1"]);
    r.clearAllPathLocks();
  });

  test("edge owners follow bidirectional traffic", () => {
    const locks = buildLocks(corridor);
    const r1 = locks.lockerFor("r1").makePathLocker(["a", "b"], () => {});
    expect(locks.snapshot().edgeLocks).toEqual([
      { fromId: "a", toId: "b", owners: [], held: false, legs: [{ from: "a", owners: [] }, { from: "b", owners: [] }] },
    ]);
    r1.arrivedAt(0);
    expect(locks.snapshot().edgeLocks).toEqual([
      {
        fromId: "a",
        toId: "b",
        owners: ["r1"],
        held: true,
        legs: [{ from: "a", owners: ["r1"] }, { from: "b", owners: [] }],
      },
    ]);
    r1.clearAllPathLocks();
    expect(locks.snapshot().edgeLocks).toEqual([
      { fromId: "a", toId: "b", owners: [], held: false, legs: [{ from: "a", owners: [] }, { from: "b", owners: [] }] },
    ]);
  });

  test("a turn-back holds both legs of the shared link", () => {
    // The locker reserves ahead until a safe stop, so a loop tour holds
    // the same link both ways at its start. The UI draws one arrow per
    // leg; this pins the shape it depends on.
    const locks = buildLocks(corridor);
    const r1 = locks.lockerFor("r1").makePathLocker(["a", "b", "a"], () => {});
    r1.arrivedAt(0);
    expect(locks.snapshot().edgeLocks).toEqual([
      {
        fromId: "a",
        toId: "b",
        owners: ["r1"],
        held: true,
        legs: [{ from: "a", owners: ["r1"] }, { from: "b", owners: ["r1"] }],
      },
    ]);
    r1.clearAllPathLocks();
  });
});
