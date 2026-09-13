import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSite } from "@fleet-manager/core";
import type { Site } from "@fleet-manager/core";

/** Load every *.json site in a directory, keyed by site name. */
export function loadSites(dir: string): Map<string, Site> {
  const sites = new Map<string, Site>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (error) {
    throw new Error(`cannot read sites dir "${dir}": ${(error as Error).message}`);
  }
  for (const file of files) {
    const site = parseSite(readFileSync(join(dir, file), "utf8"));
    if (sites.has(site.name)) throw new Error(`duplicate site name: "${site.name}"`);
    sites.set(site.name, site);
  }
  return sites;
}
