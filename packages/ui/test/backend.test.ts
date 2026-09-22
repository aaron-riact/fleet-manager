import { describe, expect, test } from "bun:test";
import { createHttpBackend } from "../src/backend.js";
import type { FetchFn } from "../src/api.js";

describe("createHttpBackend dispatch", () => {
  const input = { serialNumber: "r1", waypoints: [{ nodeId: "a", x: 0, y: 0 }] };

  test("posts orders to the site endpoint", async () => {
    const seen: Array<[string, unknown]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push([url, JSON.parse((init?.body as string) ?? "{}")]);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as FetchFn;
    await createHttpBackend("http://x", "t", fetchFn).dispatchOrder("coalescent", input);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("http://x/api/sites/coalescent/orders");
    expect(seen[0]![1]).toMatchObject({ serialNumber: "r1" });
  });

  test("forwards the exit leg when present, omits it otherwise", async () => {
    const seen: Array<unknown> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as FetchFn;
    const backend = createHttpBackend("http://x", "t", fetchFn);
    await backend.dispatchOrder("coalescent", { ...input, exit: { x: 1, y: 2 } });
    await backend.dispatchOrder("coalescent", input);
    expect(seen[0]).toMatchObject({ exit: { x: 1, y: 2 } });
    expect(seen[1]).not.toHaveProperty("exit");
  });

  test("mutations refuse while offline without touching the network", async () => {
    const prior = (globalThis as Record<string, unknown>).navigator;
    (globalThis as Record<string, unknown>).navigator = { onLine: false };
    try {
      const fetchFn = (async () => {
        throw new Error("must not fetch while offline");
      }) as unknown as FetchFn;
      const backend = createHttpBackend("http://x", "t", fetchFn);
      await expect(
        backend.dispatchOrder("c", { serialNumber: "r", waypoints: [{ nodeId: "a", x: 0, y: 0 }] }),
      ).rejects.toThrow(/offline/);
      await expect(backend.cancelOrder("c", { serialNumber: "r" })).rejects.toThrow(/offline/);
      await expect(backend.submitTask("c", { pickup: "a", dropoff: "b" })).rejects.toThrow(/offline/);
    } finally {
      if (prior === undefined) delete (globalThis as Record<string, unknown>).navigator;
      else (globalThis as Record<string, unknown>).navigator = prior;
    }
  });

  test("surfaces busy robots", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "robot r1 is busy" }), { status: 409 })) as unknown as FetchFn;
    await expect(
      createHttpBackend("http://x", "t", fetchFn).dispatchOrder("coalescent", input),
    ).rejects.toThrow(/busy/);
  });

  test("parks many through the bulk endpoint", async () => {
    const seen: Array<[string, string, unknown]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push([(init?.method ?? "GET"), url, JSON.parse((init?.body as string) ?? "{}")]);
      return new Response(
        JSON.stringify({
          ok: true,
          parked: [{ serialNumber: "r1", spot: "p1" }],
          failed: [{ serialNumber: "r2", error: "no recent pose for robot" }],
        }),
        { status: 200 },
      );
    }) as unknown as FetchFn;
    const backend = createHttpBackend("http://x", "t", fetchFn);
    await expect(backend.parkRobots("coalescent", { serialNumbers: ["r1", "r2"] })).resolves.toEqual({
      parked: [{ serialNumber: "r1", spot: "p1" }],
      failed: [{ serialNumber: "r2", error: "no recent pose for robot" }],
    });
    expect(seen).toEqual([
      ["POST", "http://x/api/sites/coalescent/park-many", { serialNumbers: ["r1", "r2"] }],
    ]);
  });

  test("parks and cancels through their endpoints", async () => {
    const seen: Array<[string, string, unknown]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push([(init?.method ?? "GET"), url, JSON.parse((init?.body as string) ?? "{}")]);
      const parked = url.endsWith("/park");
      return new Response(JSON.stringify(parked ? { ok: true, spot: "p1" } : { ok: true }), { status: 200 });
    }) as unknown as FetchFn;
    const backend = createHttpBackend("http://x", "t", fetchFn);
    await expect(backend.parkRobot("coalescent", { serialNumber: "r1" })).resolves.toEqual({ spot: "p1" });
    await expect(backend.cancelOrder("coalescent", { serialNumber: "r1" })).resolves.toBeUndefined();
    expect(seen.map(([method, url]) => `${method} ${url}`)).toEqual([
      "POST http://x/api/sites/coalescent/park",
      "POST http://x/api/sites/coalescent/orders/cancel",
    ]);
  });

  test("park errors surface", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "no free parking spot" }), { status: 409 })) as unknown as FetchFn;
    await expect(
      createHttpBackend("http://x", "t", fetchFn).parkRobot("coalescent", { serialNumber: "r1" }),
    ).rejects.toThrow(/no free parking/);
  });
});

describe("createHttpBackend tasks", () => {
  test("submits, lists, and withdraws through the tasks endpoints", async () => {
    const seen: Array<[string, string]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      seen.push([method, url]);
      if (url.endsWith("/tasks") && method === "GET") {
        return new Response(
          JSON.stringify({
            tasks: [{ id: "task-1", pickup: "a", dropoff: "b", status: "queued", createdAt: 1 }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/tasks")) {
        expect(JSON.parse((init?.body as string) ?? "{}")).toEqual({ pickup: "a", dropoff: "b" });
        return new Response(JSON.stringify({ ok: true, taskId: "task-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as FetchFn;
    const backend = createHttpBackend("http://x", "t", fetchFn);
    await expect(backend.submitTask("coalescent", { pickup: "a", dropoff: "b" })).resolves.toEqual({
      taskId: "task-1",
    });
    await expect(backend.listTasks("coalescent")).resolves.toEqual([
      { id: "task-1", pickup: "a", dropoff: "b", status: "queued", createdAt: 1 },
    ]);
    await expect(backend.withdrawTask("coalescent", "task-1")).resolves.toBeUndefined();
    expect(seen).toEqual([
      ["POST", "http://x/api/sites/coalescent/tasks"],
      ["GET", "http://x/api/sites/coalescent/tasks"],
      ["DELETE", "http://x/api/sites/coalescent/tasks/task-1"],
    ]);
  });

  test("requests, pickups, demand bumps, and the demands stream", async () => {
    const seen: Array<[string, string, unknown]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      seen.push([method, url, body]);
      if (url.endsWith("/tasks/request")) {
        return new Response(JSON.stringify({ ok: true, taskId: "task-9" }), { status: 200 });
      }
      if (url.endsWith("/pickup")) {
        return new Response(JSON.stringify({ ok: true, taskId: "task-9" }), { status: 200 });
      }
      if (url.endsWith("/demand")) {
        return new Response(JSON.stringify({ ok: true, zone: "dock", demand: 3 }), { status: 200 });
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    }) as unknown as FetchFn;
    const backend = createHttpBackend("http://x", "t", fetchFn);
    await expect(backend.submitRequest("coalescent", { dropoff: "b", zone: "dock" })).resolves.toEqual({
      taskId: "task-9",
    });
    await expect(backend.attachPickup("coalescent", "task-9", { pickup: "a" })).resolves.toBeUndefined();
    await expect(backend.bumpDemand("coalescent", { zone: "dock", count: 3 })).resolves.toEqual({
      zone: "dock",
      demand: 3,
    });
    expect(seen).toEqual([
      ["POST", "http://x/api/sites/coalescent/tasks/request", { dropoff: "b", zone: "dock" }],
      ["POST", "http://x/api/sites/coalescent/tasks/task-9/pickup", { pickup: "a" }],
      ["POST", "http://x/api/sites/coalescent/demand", { zone: "dock", count: 3 }],
    ]);
  });

  test("demands stream opens the tokenized URL and parses frames", () => {
    const opened: string[] = [];
    const backend = createHttpBackend("http://x", "t", undefined, (url: string) => {
      opened.push(url);
      return { onmessage: null, onerror: null, close: () => {} } as never;
    });
    const seen: unknown[] = [];
    const stop = backend.watchDemands("coalescent", (d) => void seen.push(d));
    expect(opened).toEqual(["http://x/api/sites/coalescent/demands/stream?token=t"]);
    stop();
  });

  test("task errors surface", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "no route" }), { status: 409 })) as unknown as FetchFn;
    const backend = createHttpBackend("http://x", "t", fetchFn);
    await expect(backend.submitTask("coalescent", { pickup: "a", dropoff: "b" })).rejects.toThrow(
      /no route/,
    );
  });
});

describe("createHttpBackend auth", () => {
  test("sends the Bearer token on every endpoint", async () => {
    const seen: Array<[string, string | null]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const raw = init?.headers as Record<string, string> | Headers | undefined;
      const auth = raw instanceof Headers
        ? raw.get("authorization")
        : (raw?.["authorization"] ?? raw?.["Authorization"] ?? null);
      seen.push([`${init?.method ?? "GET"} ${url}`, auth]);
      if (url.endsWith("/api/sites"))
        return new Response(JSON.stringify({ sites: ["coalescent"] }), { status: 200 });
      if (url.endsWith("/map"))
        return new Response(
          JSON.stringify({ name: "coalescent", nodes: [], links: [] }),
          { status: 200 },
        );
      if (url.endsWith("/tasks") && (init?.method ?? "GET") === "GET")
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      if (url.endsWith("/tasks"))
        return new Response(JSON.stringify({ ok: true, taskId: "task-1" }), { status: 200 });
      if (url.endsWith("/park"))
        return new Response(JSON.stringify({ ok: true, spot: "p1" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as FetchFn;
    const backend = createHttpBackend("http://x", "t", fetchFn);
    await backend.listSites();
    await backend.getMap("coalescent");
    await backend.dispatchOrder("coalescent", {
      serialNumber: "r1",
      waypoints: [{ nodeId: "a", x: 0, y: 0 }],
    });
    await backend.parkRobot("coalescent", { serialNumber: "r1" });
    await backend.cancelOrder("coalescent", { serialNumber: "r1" });
    await backend.submitTask("coalescent", { pickup: "a", dropoff: "b" });
    await backend.listTasks("coalescent");
    await backend.withdrawTask("coalescent", "task-1");
    expect(seen.map(([route]) => route)).toEqual([
      "GET http://x/api/sites",
      "GET http://x/api/sites/coalescent/map",
      "POST http://x/api/sites/coalescent/orders",
      "POST http://x/api/sites/coalescent/park",
      "POST http://x/api/sites/coalescent/orders/cancel",
      "POST http://x/api/sites/coalescent/tasks",
      "GET http://x/api/sites/coalescent/tasks",
      "DELETE http://x/api/sites/coalescent/tasks/task-1",
    ]);
    for (const [route, auth] of seen) expect({ route, auth }).toEqual({ route, auth: "Bearer t" });
  });
});

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
    const history: unknown[] = [];
    const conns: unknown[] = [];
    const un1 = backend.watchPoses("coalescent", (p) => void poses.push(p));
    const un2 = backend.watchLocks("coalescent", (s) => void locks.push(s));
    const un3 = backend.watchOrders("coalescent", (o) => void orders.push(o));
    const un4 = backend.watchHistory("coalescent", (h) => void history.push(h));
    const un5 = backend.watchConnections("coalescent", (c) => void conns.push(c));

    expect(opened).toEqual([
      "http://x/api/sites/coalescent/poses/stream?token=t",
      "http://x/api/sites/coalescent/locks/stream?token=t",
      "http://x/api/sites/coalescent/orders/stream?token=t",
      "http://x/api/sites/coalescent/history/stream?token=t",
      "http://x/api/sites/coalescent/connections/stream?token=t",
    ]);

    sources[0]!.onmessage!({ data: JSON.stringify({ serialNumber: "r1", x: 1, y: 2 }) });
    sources[0]!.onmessage!({ data: "not-json{" });
    sources[1]!.onmessage!({ data: JSON.stringify({ nodeLocks: [], edgeLocks: [] }) });
    sources[2]!.onmessage!({ data: JSON.stringify([]) });
    sources[3]!.onmessage!({ data: JSON.stringify([]) });
    sources[4]!.onmessage!({ data: JSON.stringify([]) });
    expect(poses).toHaveLength(1);
    expect(locks).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(conns).toHaveLength(1);

    un1();
    un2();
    un3();
    un4();
    un5();
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

  test("a stream the browser closed for good reports itself lost", () => {
    // EventSource retries a dropped connection (readyState CONNECTING), but
    // a non-200 answer, such as a 401 once the session is gone, closes it
    // for good (CLOSED). The UI used to show "live" over frozen data then.
    const sources: Array<{
      onmessage: ((event: { data: string }) => void) | null;
      onerror: ((event: unknown) => void) | null;
      readyState: number;
      close(): void;
    }> = [];
    const backend = createHttpBackend("http://x", "t", undefined, () => {
      const source = { onmessage: null, onerror: null, readyState: 0, close() {} };
      sources.push(source);
      return source;
    });
    let lost = 0;
    const stop = backend.watchLocks("coalescent", () => {}, () => void lost++);
    sources[0]!.onerror!(new Error("dropped"));
    expect(lost).toBe(0);
    sources[0]!.readyState = 2;
    sources[0]!.onerror!(new Error("401"));
    expect(lost).toBe(1);
    stop();
  });
});
