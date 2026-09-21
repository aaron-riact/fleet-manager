import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgvController, VirtualAgvAdapter } from "vda-5050-lib";
import { serializeUsersFile, OFF_GRAPH_PREFIX } from "@fleet-manager/core";
import { attachMemoryTransport } from "@fleet-manager/vda";
import { testLogin, testSrp, testUser } from "./helpers.js";
import { serve } from "../src/serve.js";

async function pollFor(label: string, cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("auto-park and the task queue", () => {
  test("a freed robot takes queued work before it parks", async () => {
    const user = await testUser("pump@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-pump-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({
        name: "coalescent",
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 10, y: 0 },
          { id: "c", x: 20, y: 0 },
        ],
        links: [
          { source: "a", destination: "b", bidirectional: true },
          { source: "b", destination: "c", bidirectional: true },
        ],
        parking: [{ id: "p1", x: 0, y: 6, entry: "a" }],
      }),
    );
    const { server, port, contexts } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      srp: testSrp,
    });
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, token?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const ctx = contexts.get("coalescent")!;

    // Every order the robot is given, in order, straight off the site's
    // own stream: a park tour is the one carrying an off-graph node.
    const dispatched: Array<{ orderId: string; nodes: string[] }> = [];
    ctx.orderSubs.add((orders) => {
      for (const o of orders) {
        if (dispatched.some((d) => d.orderId === o.orderId)) continue;
        dispatched.push({ orderId: o.orderId, nodes: o.nodes.map((n) => n.nodeId) });
      }
    });
    const isPark = (d: { nodes: string[] }) =>
      d.nodes.some((id) => id.startsWith(OFF_GRAPH_PREFIX));

    const robot = new AgvController(
      { manufacturer: "RobotCompany", serialNumber: "pump-1" },
      {
        interfaceName: "coalescent",
        vdaVersion: "2.0.0",
        transport: { brokerUrl: "mqtt://memory" },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 4, initialPosition: { mapId: "local", x: 0, y: 0, theta: 0, lastNodeId: "0" } },
    );
    attachMemoryTransport(robot, ctx.hub);
    await robot.start();

    try {
      const token = await testLogin(post, "pump@cmr", "s3cret");
      await pollFor("robot pose", () => ctx.poses.has("pump-1"), 15_000);

      const first = await post("/api/sites/coalescent/tasks", { pickup: "a", dropoff: "b" }, token);
      expect(first.status).toBe(200);
      await pollFor("first task assigned", () => ctx.fleet.isBusy("pump-1"), 15_000);

      // Queued while the robot is busy: it can only move once that tour ends.
      const second = await post("/api/sites/coalescent/tasks", { pickup: "b", dropoff: "c" }, token);
      const secondId = ((await second.json()) as { taskId: string }).taskId;
      expect(ctx.tasks.get(secondId)?.status).toBe("queued");

      await pollFor(
        "second task assigned",
        () => ctx.tasks.get(secondId)?.status === "assigned",
        30_000,
      );

      // Nothing may have gone to a parking spot in between.
      const parkIndex = dispatched.findIndex(isPark);
      expect(parkIndex).toBe(-1);
      expect(dispatched.length).toBe(2);
    } finally {
      await robot.stop();
      await server.stop();
      await ctx.stop();
    }
  }, 60_000);
});
