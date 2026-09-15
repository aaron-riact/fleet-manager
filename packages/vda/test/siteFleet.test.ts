import { describe, expect, test } from "bun:test";
import { bootSiteFleet } from "../src/siteFleet.js";

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
});
