import { describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import { createVerifier, serializeUsersFile } from "@fleet-manager/core";
import { serve } from "../src/serve.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSites } from "../src/sites.js";
import { buildSiteContexts } from "../src/serve.js";

const site = { name: "s1", nodes: [{ id: "a", x: 0, y: 0 }], links: [] };

describe("loadSites", () => {
  test("loads *.json sites keyed by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sites-"));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ ...site, name: "s2" }));
    writeFileSync(join(dir, "a.json"), JSON.stringify(site));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const sites = loadSites(dir);
    expect([...sites.keys()]).toEqual(["s1", "s2"]);
  });

  test("rejects duplicates, invalid files, missing dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sites-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify(site));
    writeFileSync(join(dir, "b.json"), JSON.stringify(site));
    expect(() => loadSites(dir)).toThrow(/duplicate site/);
    const bad = mkdtempSync(join(tmpdir(), "fleet-sites-"));
    writeFileSync(join(bad, "x.json"), "{nope");
    expect(() => loadSites(bad)).toThrow(/not valid JSON/);
    expect(() => loadSites(join(tmpdir(), "fleet-no-such-dir"))).toThrow(/cannot read sites dir/);
  });

  test("serve forwards broker options to site contexts", async () => {
    const broker = await Aedes.createBroker();
    const tcp = createServer(broker.handle);
    await new Promise<void>((resolve) => tcp.listen(0, resolve));
    const address = tcp.address();
    if (address == null || typeof address === "string") throw new Error("no broker address");
    const brokerUrl = `mqtt://localhost:${address.port}`;

    const dir = mkdtempSync(join(tmpdir(), "fleet-fwd-"));
    const usersFile = join(dir, "users.json");
    const record = await createVerifier("fwd@cmr", "s3cret");
    writeFileSync(usersFile, serializeUsersFile([{ username: "fwd@cmr", sites: ["s1"], ...record }]));
    const sitesDir = join(dir, "sites");
    mkdirSync(sitesDir);
    writeFileSync(join(sitesDir, "s1.json"), JSON.stringify(site));

    // serve() drops what it is not asked to forward; this pins that it does.
    const { stop, contexts } = await serve({ port: 0, usersFile, sitesDir, brokerUrl });
    try {
      expect(contexts.get("s1")!.master.clientOptions.transport.brokerUrl).toBe(brokerUrl);
    } finally {
      await stop();
      await new Promise<void>((resolve, reject) => {
        tcp.close((error) => (error ? reject(error) : resolve()));
      });
      broker.close();
    }
  }, 30_000);

  test("one interfaceName across several sites is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-iface-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ ...site, name: "a" }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ ...site, name: "b" }));
    await expect(
      buildSiteContexts(loadSites(dir), { interfaceName: "shared" }),
    ).rejects.toThrow(/one VDA topic namespace/);
  });
});
