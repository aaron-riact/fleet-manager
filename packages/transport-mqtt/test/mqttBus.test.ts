import { describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { MqttBus } from "../src/mqttBus.js";

async function bootBroker(): Promise<{ url: string; stop: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no broker address");
  return {
    url: `mqtt://localhost:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      broker.close();
    },
  };
}

describe("MqttBus", () => {
  test("publishes and receives across a real broker", async () => {
    const { url, stop } = await bootBroker();
    const a = new MqttBus({ url });
    const b = new MqttBus({ url });
    await a.connect();
    await b.connect();
    try {
      const seen: unknown[] = [];
      await b.subscribe("fleet/state", (m) => void seen.push(m.payload));
      await a.publish("fleet/state", { x: 1 });
      const deadline = Date.now() + 5_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen).toEqual([{ x: 1 }]);
    } finally {
      await a.close();
      await b.close();
      await stop();
    }
  }, 15_000);

  test("wildcards fan out, unsubscribe stops delivery", async () => {
    const { url, stop } = await bootBroker();
    const bus = new MqttBus({ url });
    await bus.connect();
    try {
      const all: string[] = [];
      const one: string[] = [];
      await bus.subscribe("fleet/#", (m) => void all.push(m.topic));
      const sub = await bus.subscribe("fleet/+/state", (m) => void one.push(m.topic));
      await bus.publish("fleet/r1/state", 1);
      await bus.publish("fleet/r1/order", 2);
      const deadline = Date.now() + 5_000;
      while (all.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(all.sort()).toEqual(["fleet/r1/order", "fleet/r1/state"]);
      expect(one).toEqual(["fleet/r1/state"]);
      sub.unsubscribe();
      await bus.publish("fleet/r1/state", 3);
      await new Promise((r) => setTimeout(r, 300));
      expect(one).toEqual(["fleet/r1/state"]);
    } finally {
      await bus.close();
      await stop();
    }
  }, 15_000);

  test("concurrent connects share one client", async () => {
    const { url, stop } = await bootBroker();
    const bus = new MqttBus({ url });
    try {
      await Promise.all([bus.connect(), bus.connect(), bus.connect()]);
      const seen: unknown[] = [];
      await bus.subscribe("fleet/once", (m) => void seen.push(m.payload));
      await bus.publish("fleet/once", { n: 1 });
      const deadline = Date.now() + 5_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // one client, so exactly one delivery — not one per connect() call
      expect(seen).toEqual([{ n: 1 }]);
    } finally {
      await bus.close();
      await stop();
    }
  }, 15_000);

  test("requires connect, rejects bad filters", async () => {
    const bus = new MqttBus({ url: "mqtt://localhost:1" });
    await expect(bus.publish("a", 1)).rejects.toThrow(/not connected/);
    await expect(bus.subscribe("a", () => {})).rejects.toThrow(/not connected/);
    const { url, stop } = await bootBroker();
    const live = new MqttBus({ url });
    await live.connect();
    try {
      await expect(live.subscribe("a/#/c", () => {})).rejects.toThrow();
    } finally {
      await live.close();
      await stop();
    }
  }, 15_000);
});
