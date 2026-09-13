import { describe, expect, test } from "bun:test";
import { fetchMap, fetchSites } from "../src/api.js";

const ok = (data: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(data), { status: 200 })) as unknown as typeof fetch;

describe("api client", () => {
  test("sites and map", async () => {
    expect(await fetchSites("http://x", "t", ok({ sites: ["coalescent"] }))).toEqual(["coalescent"]);
    const site = { name: "coalescent", nodes: [{ id: "a", x: 0, y: 0 }], links: [] };
    expect(await fetchMap("http://x", "t", "coalescent", ok(site))).toEqual(site);
  });

  test("errors surface", async () => {
    const fail: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: "forbidden site" }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchMap("http://x", "t", "other", fail)).rejects.toThrow(/forbidden site/);
  });
});
