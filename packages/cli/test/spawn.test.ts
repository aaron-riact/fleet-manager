import { describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import { MasterController, Topic } from "vda-5050-lib";
import { spawnRobot } from "../src/spawn.js";

describe("spawnRobot", () => {
  test("rejects empty serial without touching the network", async () => {
    await expect(spawnRobot({ brokerUrl: "mqtt://localhost:1", interfaceName: "x", serial: "" })).rejects.toThrow(
      /serial is required/,
    );
  });

  test("virtual robot publishes state a master can see", async () => {
    const broker = await Aedes.createBroker();
    const server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("no broker address");
    const brokerUrl = `mqtt://localhost:${address.port}`;

    const master = new MasterController(
      {
        interfaceName: "spawn-test",
        vdaVersion: "2.0.0",
        transport: { brokerUrl },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      {},
    );
    await master.start();
    try {
      const seen: string[] = [];
      await (master as unknown as {
        subscribeTopic(t: Topic, s: object, h: (o: { serialNumber?: string }) => void): Promise<string>;
      }).subscribeTopic(Topic.State, { manufacturer: "RobotCompany" }, (o) => {
        if (o.serialNumber) seen.push(o.serialNumber);
      });
      const controller = new AbortController();
      const running = spawnRobot({
        brokerUrl,
        interfaceName: "spawn-test",
        serial: "spawn-1",
        signal: controller.signal,
      });
      const deadline = Date.now() + 15_000;
      while (!seen.includes("spawn-1") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      controller.abort();
      await running;
      expect(seen).toContain("spawn-1");
    } finally {
      await master.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      broker.close();
    }
  }, 30_000);
});
