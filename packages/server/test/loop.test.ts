import { describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import { AgvController, VirtualAgvAdapter } from "vda-5050-lib";
import { serializeUsersFile } from "@fleet-manager/core";
import { serve } from "../src/serve.js";
import { testLogin, testSrp, testUser } from "./helpers.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class StreamReader {
  private buf = "";
  private decoder = new TextDecoder();
  private constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  static async open(url: string): Promise<StreamReader> {
    const res = await fetch(url);
    if (res.status !== 200) throw new Error(`stream ${url} -> ${res.status}`);
    return new StreamReader(res.body!.getReader());
  }

  async next(timeoutMs = 15_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.buf.indexOf("\n\n");
      if (idx >= 0) {
        const frame = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const match = /^data: (.*)$/s.exec(frame);
        if (match) return JSON.parse(match[1]!);
        continue;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for SSE frame");
      const { done, value } = await this.reader.read();
      if (done) throw new Error("stream closed");
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

describe("full loop over MQTT", () => {
  test("spawned robot traverses a dispatched tour", async () => {
    const broker = await Aedes.createBroker();
    const tcp = createServer(broker.handle);
    await new Promise<void>((resolve) => tcp.listen(0, resolve));
    const address = tcp.address();
    if (address == null || typeof address === "string") throw new Error("no broker address");
    const brokerUrl = `mqtt://localhost:${address.port}`;

    const user = await testUser("loop@cmr", "s3cret", ["coalescent"]);
    const dir = mkdtempSync(join(tmpdir(), "fleet-loop-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([user]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(
      join(sitesDir, "coalescent.json"),
      JSON.stringify({
        name: "coalescent",
        nodes: [
          { id: "west", x: 0, y: 4 },
          { id: "east", x: 12, y: 4 },
        ],
        links: [{ source: "west", destination: "east", bidirectional: true }],
      }),
    );
    const { port, contexts, stop } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      brokerUrl,
      interfaceName: "coalescent",
      srp: testSrp,
    });
    const base = `http://localhost:${port}`;
    const robot = new AgvController(
      { manufacturer: "RobotCompany", serialNumber: "loop-1" },
      {
        interfaceName: "coalescent",
        vdaVersion: "2.0.0",
        transport: { brokerUrl },
        topicObjectValidation: { inbound: false, outbound: false },
      },
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 8, initialPosition: { mapId: "local", x: 0, y: 4, theta: 0, lastNodeId: "0" } },
    );
    try {
      await robot.start();

      const post = (path: string, body: unknown, token?: string) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      const token = await testLogin(post, "loop@cmr", "s3cret");

      // subscribe before dispatching: grants and completion both push
      const locks = await StreamReader.open(`${base}/api/sites/coalescent/locks/stream?token=${token}`);
      const orders = await StreamReader.open(`${base}/api/sites/coalescent/orders/stream?token=${token}`);
      const history = await StreamReader.open(`${base}/api/sites/coalescent/history/stream?token=${token}`);
      try {
        type Locks = { nodeLocks: Array<{ id: string; owners: string[] }> };
        const baseline = (await locks.next()) as Locks;
        expect(baseline.nodeLocks.find((n) => n.id === "west")?.owners).toEqual([]);

        const dispatch = await post(
          "/api/sites/coalescent/orders",
          {
            serialNumber: "loop-1",
            waypoints: [
              { nodeId: "west", x: 0, y: 4 },
              { nodeId: "east", x: 12, y: 4 },
            ],
          },
          token,
        );
        expect(dispatch.status).toBe(200);

        // grant push names the robot…
        for (;;) {
          const frame = (await locks.next(15_000)) as Locks;
          if (frame.nodeLocks.some((n) => n.owners.includes("loop-1"))) break;
        }
        expect(
          contexts.get("coalescent")!.locks.snapshot().nodeLocks.find((n) => n.id === "west")?.owners,
        ).toEqual(["loop-1"]);

        // …and completion empties the orders feed
        let sighted = false;
        const deadline = Date.now() + 45_000;
        for (;;) {
          const frame = (await orders.next(15_000)) as unknown[];
          if (!Array.isArray(frame)) continue;
          if (frame.length > 0) {
            sighted = true;
            continue;
          }
          if (sighted) break;
          if (Date.now() > deadline) throw new Error("tour did not complete in time");
        }

        // …and the finished tour lands in history exactly once
        type History = Array<{ serial: string; outcome: string }>;
        const historyDeadline = Date.now() + 45_000;
        for (;;) {
          const frame = (await history.next(15_000)) as History;
          if (!Array.isArray(frame) || frame.length === 0) {
            if (Date.now() > historyDeadline) throw new Error("history did not record the tour");
            continue;
          }
          expect(frame).toHaveLength(1);
          expect(frame[0]).toMatchObject({ serial: "loop-1", outcome: "completed" });
          break;
        }
      } finally {
        await locks.close();
        await orders.close();
        await history.close();
      }
    } finally {
      await robot.stop();
      // stop() closes the site fleets too. Without it the server's own
      // MQTT connection stays open and tcp.close() never calls back.
      await stop();
      await new Promise<void>((resolve, reject) => {
        tcp.close((error) => (error ? reject(error) : resolve()));
      });
      broker.close();
    }
  }, 90_000);
});
