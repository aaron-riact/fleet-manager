import { parseSite } from "@fleet-manager/core";
import type { Site } from "@fleet-manager/core";
import coalescentJson from "../../../data/seed/sites/coalescent.json";
import demoJson from "../../../data/seed/sites/demo.json";

/**
 * Maps bundled with the demo. Parsed (not cast) at load so a broken
 * seed fails loudly here instead of as a blank page later.
 */
function load(name: string, json: unknown): Site {
  try {
    const site = parseSite(JSON.stringify(json));
    if (site.name !== name) throw new Error(`seed name is "${site.name}", expected "${name}"`);
    return site;
  } catch (error) {
    throw new Error(`bundled site "${name}" is invalid: ${(error as Error).message}`);
  }
}

export const SITES: Record<string, Site> = {
  demo: load("demo", demoJson),
  coalescent: load("coalescent", coalescentJson),
};

export const SITE_NAMES = Object.keys(SITES);

/**
 * Initial demo site: `#/site=<name>` hash wins (shareable links),
 * then the FLEET_SITE environment default, then demo. Unknown names
 * fall back instead of stranding on an empty world. Pure, tested.
 */
export function selectInitialSite(envSite?: string, hash?: string): string {
  const fromHash = hash?.match(/^#\/site=([^/]+)\/?$/)?.[1];
  for (const candidate of [fromHash, envSite]) {
    if (candidate && SITES[candidate]) return candidate;
  }
  return "demo";
}
