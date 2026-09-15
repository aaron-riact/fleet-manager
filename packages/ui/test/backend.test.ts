import { describe, expect, test } from "bun:test";
import { createHttpBackend } from "../src/backend.js";
import type { FetchFn } from "../src/api.js";

describe("createHttpBackend", () => {
  test("delegates to sites + map endpoints", async () => {
    const backend = createHttpBackend(
      "http://x",
      "t",
      (async (url: string) => {
        if (url.endsWith("/api/sites"))
          return new Response(JSON.stringify({ sites: ["coalescent"] }), { status: 200 });
        return new Response(
          JSON.stringify({ name: "coalescent", nodes: [{ id: "a", x: 0, y: 0 }], links: [] }),
          { status: 200 },
        );
      }) as unknown as FetchFn,
    );
    expect(await backend.listSites()).toEqual(["coalescent"]);
    expect((await backend.getMap("coalescent")).name).toBe("coalescent");
  });

  test("surfaces server errors", async () => {
    const failing = createHttpBackend(
      "http://x",
      "t",
      (async () =>
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as unknown as FetchFn,
    );
    await expect(failing.listSites()).rejects.toThrow(/forbidden/);
    await expect(failing.getMap("coalescent")).rejects.toThrow(/forbidden/);
  });
});
