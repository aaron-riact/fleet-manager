import { describe, expect, test } from "bun:test";
import { nearestNode, shortestPath } from "@fleet-manager/core";
import { SITE_NAMES, SITES, selectInitialSite } from "../src/sites.js";

describe("bundled demo sites", () => {
  test("every bundled map is bootable", () => {
    expect(SITE_NAMES.sort()).toEqual(["coalescent", "demo"]);
    for (const name of SITE_NAMES) {
      const site = SITES[name]!;
      expect(site.name).toBe(name);
      // parking entries resolve: robots spawn onto the graph, not the void
      for (const spot of site.parking ?? []) {
        if (spot.entry !== undefined) {
          expect(site.nodes.some((n) => n.id === spot.entry)).toBe(true);
        }
      }
      // every station addresses a reachable node through its drop pose
      for (const location of site.locations ?? []) {
        if (!location.dropPose) continue;
        const nearest = nearestNode(site, location.dropPose.x, location.dropPose.y);
        expect(nearest).toBeDefined();
      }
      // the graph is strongly connected: any tour is plannable
      const ids = site.nodes.map((n) => n.id);
      for (const a of ids) {
        expect(shortestPath(site, a, ids[0])).toBeDefined();
      }
    }
  });

  test("selectInitialSite prefers hash, then env, then demo", () => {
    expect(selectInitialSite("coalescent", "#/site=demo")).toBe("demo");
    expect(selectInitialSite("coalescent", "")).toBe("coalescent");
    expect(selectInitialSite("ghost", "")).toBe("demo");
    expect(selectInitialSite(undefined, "#/site=ghost")).toBe("demo");
    expect(selectInitialSite()).toBe("demo");
  });
});
