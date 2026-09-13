import { describe, expect, test } from "bun:test";
import { MemoryBus } from "../src/memoryBus.js";

describe("MemoryBus", () => {
  test("delivers to exact subscriber, not others", async () => {
    const bus = new MemoryBus();
    const seen: unknown[] = [];
    await bus.subscribe("fleet/state", (m) => seen.push(m.payload));
    await bus.subscribe("fleet/order", () => {
      throw new Error("should not fire");
    });
    await bus.publish("fleet/state", { x: 1 });
    expect(seen).toEqual([{ x: 1 }]);
    await bus.close();
  });

  test("wildcards route like a broker", async () => {
    const bus = new MemoryBus();
    const all: string[] = [];
    const one: string[] = [];
    await bus.subscribe("fleet/#", (m) => all.push(m.topic));
    await bus.subscribe("fleet/+/state", (m) => one.push(m.topic));
    await bus.publish("fleet/robot1/state", 1);
    await bus.publish("fleet/robot1/order", 2);
    expect(all).toEqual(["fleet/robot1/state", "fleet/robot1/order"]);
    expect(one).toEqual(["fleet/robot1/state"]);
    await bus.close();
  });

  test("unsubscribe stops delivery", async () => {
    const bus = new MemoryBus();
    let count = 0;
    const sub = await bus.subscribe("a", () => count++);
    await bus.publish("a", 1);
    sub.unsubscribe();
    await bus.publish("a", 2);
    expect(count).toBe(1);
    expect(bus.size).toBe(0);
    await bus.close();
  });

  test("rejects invalid filters and closed bus", async () => {
    const bus = new MemoryBus();
    expect(bus.subscribe("a/#/c", () => {})).rejects.toThrow();
    expect(bus.subscribe("a/b+c", () => {})).rejects.toThrow();
    await bus.close();
    expect(bus.publish("a", 1)).rejects.toThrow();
  });
});
