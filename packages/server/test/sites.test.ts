import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSites } from "../src/sites.js";

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
});
