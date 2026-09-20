import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { FleetMap } from "../src/FleetMap.js";
import type { Site } from "@fleet-manager/core";

// One vertical edge; SSR keeps this free of DOM test infra.
const site = {
  nodes: [
    { id: "s", x: 0, y: 0 },
    { id: "n", x: 0, y: 4 },
  ],
  links: [{ source: "s", destination: "n", bidirectional: true }],
} as unknown as Site;

function lockArrowTips(locks: unknown): Array<{ x: number; y: number }> {
  const html = renderToStaticMarkup(React.createElement(FleetMap, { site, locks } as never));
  const tags = [...html.matchAll(/<polygon[^>]*>/g)].map((m) => m[0]);
  return tags
    .filter((t) => t.includes('fill="#f0883e"') && !t.includes("stroke="))
    .map((t) => {
      const [tip] = t.match(/points="([^"]+)"/)![1]!.split(" ");
      const [x, y] = tip!.split(",").map(Number);
      return { x: x!, y: y! };
    });
}

describe("locking-direction arrows", () => {
  test("opposing held legs sit side by side, pointing along travel", () => {
    const tips = lockArrowTips({
      nodeLocks: [],
      edgeLocks: [
        {
          fromId: "s",
          toId: "n",
          owners: ["r1", "r2"],
          held: true,
          legs: [
            { from: "s", owners: ["r1"] },
            { from: "n", owners: ["r2"] },
          ],
        },
      ],
    });
    expect(tips).toHaveLength(2);
    // Separate lanes: ~2x the 0.16m lane offset apart across the edge.
    expect(Math.abs(tips[0]!.x - tips[1]!.x)).toBeGreaterThan(0.25);
    // Opposing headings: one tip north of its base, the other south.
    // (Tips alone suffice: same-lane collapse put both tips on one x.)
  });

  test("single held leg draws one arrow", () => {
    const tips = lockArrowTips({
      nodeLocks: [],
      edgeLocks: [
        {
          fromId: "s",
          toId: "n",
          owners: ["r1"],
          held: true,
          legs: [
            { from: "s", owners: ["r1"] },
            { from: "n", owners: [] },
          ],
        },
      ],
    });
    expect(tips).toHaveLength(1);
  });
});
