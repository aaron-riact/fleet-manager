import { describe, expect, test } from "bun:test";
import { Topic } from "vda-5050-lib";
import { bootFleet } from "../src/fleet.js";

describe("runtime robot management", () => {
  test("spawned robot appears on the bus; dropped robot leaves", async () => {
    const fleet = await bootFleet({ robots: [] });
    try {
      const seen = new Set<string>();
      const master = fleet.master as unknown as {
        subscribeTopic(t: Topic, s: object, h: (o: { serialNumber?: string }) => void): Promise<string>;
      };
      await master.subscribeTopic(Topic.State, { manufacturer: "RobotCompany" }, (o) => {
        if (o.serialNumber) seen.add(o.serialNumber);
      });

      await fleet.spawn({ manufacturer: "RobotCompany", serialNumber: "extra-1" });
      await fleet.spawn({ manufacturer: "RobotCompany", serialNumber: "extra-2" });
      expect(fleet.robots.map((r) => r.id.serialNumber).sort()).toEqual(["extra-1", "extra-2"]);
      await expect(
        fleet.spawn({ manufacturer: "RobotCompany", serialNumber: "extra-1" }),
      ).rejects.toThrow(/already exists/);

      const deadline = Date.now() + 10_000;
      while ((!seen.has("extra-1") || !seen.has("extra-2")) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(seen.has("extra-1")).toBe(true);
      expect(seen.has("extra-2")).toBe(true);

      expect(await fleet.drop("extra-1")).toBe(true);
      expect(await fleet.drop("extra-1")).toBe(false);
      expect(fleet.robots.map((r) => r.id.serialNumber)).toEqual(["extra-2"]);
    } finally {
      await fleet.stop();
    }
  }, 20_000);
});
