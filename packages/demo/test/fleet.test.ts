import { describe, expect, test } from "bun:test";
import { Topic } from "vda-5050-lib";
import { bootFleet } from "../src/fleet.js";

describe("in-page fleet", () => {
  test("virtual AGV state reaches the master, no broker", async () => {
    const fleet = await bootFleet({
      robots: [{ manufacturer: "RobotCompany", serialNumber: "demo-1" }],
    });
    try {
      const received: unknown[] = [];
      const master = fleet.master as unknown as {
        subscribeTopic(t: Topic, s: object, h: (o: unknown) => void): Promise<string>;
      };
      await master.subscribeTopic(
        Topic.State,
        { manufacturer: "RobotCompany", serialNumber: "demo-1" },
        (o) => void received.push(o),
      );
      const deadline = Date.now() + 10_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(received.length).toBeGreaterThan(0);
      expect(received[0]).toMatchObject({ serialNumber: "demo-1" });
    } finally {
      await fleet.stop();
    }
  }, 15_000);
});
