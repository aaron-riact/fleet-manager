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

  test("watchers open tokenized SSE streams and parse frames", () => {
    const opened: string[] = [];
    const sources: Array<{
      onmessage: ((event: { data: string }) => void) | null;
      onerror: ((event: unknown) => void) | null;
      closed: boolean;
      close(): void;
    }> = [];
    const openEventSource = (url: string) => {
      opened.push(url);
      const source = {
        onmessage: null as ((event: { data: string }) => void) | null,
        onerror: null as ((event: unknown) => void) | null,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      sources.push(source);
      return source;
    };
    const backend = createHttpBackend("http://x", "t", undefined, openEventSource);

    const poses: unknown[] = [];
    const locks: unknown[] = [];
    const orders: unknown[] = [];
    const un1 = backend.watchPoses("coalescent", (p) => void poses.push(p));
    const un2 = backend.watchLocks("coalescent", (s) => void locks.push(s));
    const un3 = backend.watchOrders("coalescent", (o) => void orders.push(o));

    expect(opened).toEqual([
      "http://x/api/sites/coalescent/poses/stream?token=t",
      "http://x/api/sites/coalescent/locks/stream?token=t",
      "http://x/api/sites/coalescent/orders/stream?token=t",
    ]);

    sources[0]!.onmessage!({ data: JSON.stringify({ serialNumber: "r1", x: 1, y: 2 }) });
    sources[0]!.onmessage!({ data: "not-json{" });
    sources[1]!.onmessage!({ data: JSON.stringify({ nodeLocks: [], edgeLocks: [] }) });
    sources[2]!.onmessage!({ data: JSON.stringify([]) });
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);

    un1();
    un2();
    un3();
    expect(sources.every((s) => s.closed)).toBe(true);
  });

  test("a stream error leaves the source open for EventSource to retry", () => {
    const sources: Array<{
      onmessage: ((event: { data: string }) => void) | null;
      onerror: ((event: unknown) => void) | null;
      closed: boolean;
      close(): void;
    }> = [];
    const backend = createHttpBackend("http://x", "t", undefined, () => {
      const source = {
        onmessage: null as ((event: { data: string }) => void) | null,
        onerror: null as ((event: unknown) => void) | null,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      sources.push(source);
      return source;
    });

    const seen: unknown[] = [];
    const stop = backend.watchPoses("coalescent", (p) => void seen.push(p));
    sources[0]!.onerror!(new Error("dropped"));
    expect(sources[0]!.closed).toBe(false);
    // the retried connection keeps delivering
    sources[0]!.onmessage!({ data: JSON.stringify({ serialNumber: "r1", x: 1, y: 2 }) });
    expect(seen).toHaveLength(1);
    stop();
    expect(sources[0]!.closed).toBe(true);
  });
});
