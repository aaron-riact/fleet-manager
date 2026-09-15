import { describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import { AgvController, VirtualAgvAdapter } from "vda-5050-lib";
import { createVerifier, serializeUsersFile, srpClient } from "@fleet-manager/core";
import { serve } from "../src/serve.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("full loop over MQTT", () => {
  test("spawned robot traverses a dispatched tour", async () => {
    const broker = await Aedes.createBroker();
    const tcp = createServer(broker.handle);
    await new Promise<void>((resolve) => tcp.listen(0, resolve));
    const address = tcp.address();
    if (address == null || typeof address === "string") throw new Error("no broker address");
    const brokerUrl = `mqtt://localhost:${address.port}`;

    const record = await createVerifier("loop@cmr", "s3cret");
    const dir = mkdtempSync(join(tmpdir(), "fleet-loop-"));
    const file = join(dir, "users.json");
    writeFileSync(file, serializeUsersFile([{ username: "loop@cmr", sites: ["coalescent"], ...record }]));
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
    const { port, stop } = await serve({
      port: 0,
      usersFile: file,
      sitesDir,
      brokerUrl,
      interfaceName: "coalescent",
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
      const step1 = await (await post("/api/login/start", { username: "loop@cmr" })).json();
      const key = await srpClient.derivePrivateKey(step1.salt, "loop@cmr", "s3cret");
      const eph = srpClient.generateEphemeral();
      const sess = await srpClient.deriveSession(eph.secret, step1.serverEphemeral, step1.salt, "loop@cmr", key);
      const { token } = await (
        await post("/api/login/finish", {
          serverEphemeral: step1.serverEphemeral,
          clientEphemeral: eph.public,
          proof: sess.proof,
        })
      ).json();

      // open the stream first: the grant push fires during dispatch
      const stream = await fetch(`${base}/api/sites/coalescent/locks/stream?token=${token}`);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      async function nextFrame(timeoutMs = 30_000): Promise<{
        nodeLocks: Array<{ id: string; owners: string[] }>;
      }> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const match = /^data: (.*)$/s.exec(frame);
            if (match) return JSON.parse(match[1]!);
            continue;
          }
          if (Date.now() > deadline) throw new Error("timed out waiting for SSE frame");
          const { done, value } = await reader.read();
          if (done) throw new Error("stream closed");
          buf += decoder.decode(value, { stream: true });
        }
      }
      try {
        const baseline = await nextFrame();
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

        // the grant push names the robot; the tour then drives over MQTT
        const pushed = await nextFrame();
        expect(pushed.nodeLocks.find((n) => n.id === "west")?.owners).toEqual(["loop-1"]);
      } finally {
        await reader.cancel();
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
  }, 60_000);
});
