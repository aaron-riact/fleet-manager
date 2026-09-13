import { describe, expect, test } from "bun:test";
import { Graferse } from "graferse";

// Smoke test: the published graferse library behaves like fm-vda5050's
// local graph.ts (ported expectations from fm-vda5050/src/graph.test.ts).
describe("graferse locks", () => {
  test("creates and tracks locks", () => {
    const creator = new Graferse();
    expect(creator.locks).toEqual([]);
    const lock = creator.makeLock();
    expect(typeof lock).toBe("object");
    expect(creator.locks).toEqual([lock]);
  });

  test("exclusive lock with waiter notification", () => {
    const creator = new Graferse();
    const lock = creator.makeLock();
    expect(lock.requestLock("agent1", "node-a")).toBe(true);
    expect(lock.requestLock("agent2", "node-a")).toBe(false);
    expect(lock.unlock("agent1")).toEqual(new Set(["agent2"]));
    expect(lock.requestLock("agent2", "node-a")).toBe(true);
  });
});
