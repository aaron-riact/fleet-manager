import { describe, expect, test } from "bun:test";
import { MAX_RETAINED_TASKS, pumpSiteTasks } from "../src/serve.js";
import type { TaskPump, TaskView } from "../src/serve.js";
import type { Site } from "@fleet-manager/core";

const site: Site = {
  name: "tasks",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
    { id: "c", x: 10, y: 10 },
  ],
  links: [
    { source: "a", destination: "b", bidirectional: true },
    { source: "b", destination: "c", bidirectional: true },
  ],
};

const pose = (serial: string, x: number, y: number, seenAt = Date.now()) => ({
  manufacturer: "RobotCompany",
  serialNumber: serial,
  x,
  y,
  theta: 0,
  driving: false,
  charging: false,
  positionInitialized: true,
  eStop: false,
  fieldViolation: false,
  seenAt,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<TaskPump> = {}) {
  const calls: Array<{ serial: string; waypoints: Array<{ nodeId: string }> }> = [];
  const busy = new Set<string>();
  let failWith: unknown;
  const fleet = {
    isBusy: (serial: string) => busy.has(serial),
    dispatch: async (agv: { serialNumber: string }, waypoints: Array<{ nodeId: string }>) => {
      calls.push({ serial: agv.serialNumber, waypoints });
      if (failWith) throw failWith;
      return "fleet-order-9";
    },
  };
  const tasks = new Map<string, TaskView>();
  const base: TaskPump = {
    site,
    fleet,
    poses: new Map(),
    tasks,
    poseTtlMs: 30_000,
    ...over,
  };
  return { base, calls, busy, tasks, setFail: (e: unknown) => (failWith = e) };
}

const queued = (id: string, pickup = "a", dropoff = "c"): TaskView => ({
  id,
  pickup,
  dropoff,
  status: "queued",
  createdAt: 1_000,
});

describe("pumpSiteTasks", () => {
  test("assigns the nearest free robot along the routed path", async () => {
    const { base, calls, tasks } = setup({
      poses: new Map([
        ["far", pose("far", 0, 0)],
        ["near", pose("near", 9, 0)],
      ]),
    });
    tasks.set("t1", queued("t1", "c", "a"));
    pumpSiteTasks(base);
    const task = tasks.get("t1")!;
    expect(task.status).toBe("assigned");
    expect(task.assignee).toBe("near");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.waypoints.map((w) => w.nodeId)).toEqual(["c", "b", "a"]);
    await flush();
    expect(task.status).toBe("done");
    expect(task.orderId).toBe("fleet-order-9");
  });

  test("busy robots and stale poses are skipped; nothing free stays queued", () => {
    const { base, calls, tasks, busy } = setup({
      poses: new Map([
        ["busy-1", pose("busy-1", 9, 0)],
        ["stale-1", pose("stale-1", 9, 0, 0)],
      ]),
    });
    busy.add("busy-1");
    tasks.set("t1", queued("t1"));
    pumpSiteTasks(base);
    expect(tasks.get("t1")!.status).toBe("queued");
    expect(calls).toHaveLength(0);
  });

  test("dispatch failure fails the task with the reason", async () => {
    const { base, tasks, setFail } = setup({
      poses: new Map([["r1", pose("r1", 0, 0)]]),
    });
    setFail(new Error("boom"));
    tasks.set("t1", queued("t1"));
    pumpSiteTasks(base);
    await flush();
    expect(tasks.get("t1")).toMatchObject({ status: "failed", reason: "boom", assignee: "r1" });
  });

  test("unknown nodes and missing routes fail fast", () => {
    const { base, tasks } = setup({ poses: new Map([["r1", pose("r1", 0, 0)]]) });
    tasks.set("t1", queued("t1", "ghost", "c"));
    tasks.set("t2", { ...queued("t2", "a", "c"), pickup: "a", dropoff: "c" });
    // island is a known node with no links: routed, not found
    const island = { ...site, nodes: [...site.nodes, { id: "island", x: 99, y: 99 }] };
    tasks.set("t3", queued("t3", "a", "island"));
    pumpSiteTasks({ ...base, site: island });
    expect(tasks.get("t1")!.status).toBe("failed");
    expect(tasks.get("t2")!.status).toBe("assigned");
    expect(tasks.get("t3")).toMatchObject({ status: "failed", reason: expect.stringMatching(/no route/) });
  });

  test("terminal tasks are bounded, live ones never dropped", () => {
    const { base, tasks } = setup({ poses: new Map() });
    for (let i = 0; i < MAX_RETAINED_TASKS + 5; i++) {
      tasks.set(`done-${i}`, { ...queued(`done-${i}`), status: "done", createdAt: i });
    }
    tasks.set("live", queued("live"));
    pumpSiteTasks(base);
    expect(tasks.has("live")).toBe(true);
    expect([...tasks.values()].filter((t) => t.status === "done")).toHaveLength(MAX_RETAINED_TASKS);
  });

  test("a nested pump call does not walk the task map twice", () => {
    // dispatch() emits onOrders synchronously in the real Fleet, which
    // re-enters the pump mid-loop; the guard must make that a no-op
    const tasks = new Map<string, TaskView>();
    const poses = new Map([["r1", pose("r1", 0, 0)]]);
    let depth = 0;
    let maxDepth = 0;
    let dispatches = 0;
    const busy = new Set<string>();
    const pump: TaskPump = {
      site,
      poses,
      tasks,
      poseTtlMs: 30_000,
      fleet: {
        // the real Fleet marks the robot busy before emitting onOrders
        isBusy: (serial) => busy.has(serial),
        dispatch: async (agv) => {
          dispatches += 1;
          busy.add(agv.serialNumber);
          depth += 1;
          maxDepth = Math.max(maxDepth, depth);
          pumpSiteTasks(pump); // what onOrders does
          depth -= 1;
          return "order-1";
        },
      },
    };
    for (const id of ["t1", "t2"]) {
      tasks.set(id, {
        id,
        pickup: "a",
        dropoff: "c",
        status: "queued",
        createdAt: Date.now(),
      });
    }
    pumpSiteTasks(pump);
    expect(maxDepth).toBe(1);
    // one robot, so exactly one task went out — not one per re-entry
    expect(dispatches).toBe(1);
    expect([...tasks.values()].filter((t) => t.status === "queued")).toHaveLength(1);
  });
});
