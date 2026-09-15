import { describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import { AgvController, VirtualAgvAdapter } from "vda-5050-lib";
import { bootSiteFleet } from "../src/siteFleet.js";
import { watchRobots } from "../src/robots.js";

const site = {
  name: "short",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 5, y: 0 },
  ],
  links: [{ source: "a", destination: "b", bidirectional: true }],
};

describe("bootSiteFleet", () => {
  test("dispatch engages locks without any AGV", async () => {
    const seen: string[][] = [];
    const ctx = await bootSiteFleet(site, "site-test", {
      onLocks: (snap) => {
        void seen.push(snap.nodeLocks.filter((n) => n.owners.length > 0).map((n) => n.id));
      },
    });
    try {
      const pending = ctx.fleet.dispatch(
        { manufacturer: "T", serialNumber: "solo-1" },
        [{ nodeId: "a", x: 0, y: 0 }],
      );
      pending.catch(() => {});
      const deadline = Date.now() + 10_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // single-node tour: the entry engages immediately
      expect(seen.length).toBeGreaterThan(0);
      expect(ctx.locks.snapshot().nodeLocks.find((n) => n.id === "a")?.owners).toEqual(["solo-1"]);
    } finally {
      await ctx.stop();
    }
  }, 30_000);

  test("virtual AGV connects over a real broker", async () => {
    const broker = await Aedes.createBroker();
    const server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("no broker address");
    const brokerUrl = `mqtt://localhost:${address.port}`;
    const ctx = await bootSiteFleet(site, "mqtt-test", {}, { brokerUrl });
    const controller = new AgvController(
      { manufacturer: "RobotCompany", serialNumber: "mqtt-1" },
      {
        interfaceName: "mqtt-test",
        vdaVersion: "2.0.0",
        transport: { brokerUrl },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 2 },
    );
    try {
      await controller.start();
      const latest = new Map<string, { x: number }>();
      const stop = await watchRobots(ctx.master, "RobotCompany", (pose) => {
        latest.set(pose.serialNumber, pose);
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!latest.has("mqtt-1") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(latest.has("mqtt-1")).toBe(true);
      } finally {
        stop();
      }
    } finally {
      await controller.stop();
      await ctx.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      broker.close();
    }
  }, 30_000);
});
