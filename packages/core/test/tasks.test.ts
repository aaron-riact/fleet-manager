import { describe, expect, test } from "bun:test";
import { MAX_RETAINED_TASKS, pumpSiteTasks } from "../src/tasks.js";
import type { TaskPump, TaskView } from "../src/tasks.js";
import type { Site } from "../src/site.js";

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
  // Tasks name stations. Each hangs off the node of the same letter.
  locations: [
    { id: "A", entry: "a", pickPose: { x: 0, y: 1 }, dropPose: { x: 0, y: -1 } },
    { id: "B", entry: "b", pickPose: { x: 10, y: 1 }, dropPose: { x: 10, y: -1 } },
    { id: "C", entry: "c", pickPose: { x: 10, y: 11 }, dropPose: { x: 10, y: 9 } },
  ],
};

const pose = (serial: string, x: number, y: number, seenAt = Date.now()) => ({
  manufacturer: "RobotCompany",
  serialNumber: serial,
  x,
  y,
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
      // mirrors the real Fleet: the order registers synchronously, so a
      // second assignment later in the same pump run sees the robot taken
      busy.add(agv.serialNumber);
      return "fleet-order-9";
    },
  };
  const tasks = new Map<string, TaskView>();
  const base: TaskPump = {
    site,
    fleet,
    poses: new Map(),
    tasks,
    demands: {},
    poseTtlMs: 30_000,
    ...over,
  };
  return { base, calls, busy, tasks, setFail: (e: unknown) => (failWith = e) };
}

const queued = (id: string, pickup = "A", dropoff = "C"): TaskView => ({
  id,
  pickup,
  dropoff,
  status: "queued",
  createdAt: 1_000,
});

describe("pumpSiteTasks", () => {
  test("attachments ride the tour ends, middle nodes stay drive-through", async () => {
    const seen: Array<[string, string]> = [];
    const { base, calls, tasks } = setup({
      poses: new Map([["r1", pose("r1", 0, 0)]]),
      attachments: (stationId, role) => {
        seen.push([stationId, role]);
        return role === "pickup"
          ? [{ actionType: "pickTrolley", blockingType: "HARD" }]
          : [{ actionType: "dropTrolley", blockingType: "HARD" }];
      },
    });
    tasks.set("t1", queued("t1", "A", "C"));
    pumpSiteTasks(base);
    await flush();
    // work is asked for by station; the waypoints are still nodes
    expect(seen).toEqual([
      ["A", "pickup"],
      ["C", "dropoff"],
    ]);
    const waypoints = calls[0]!.waypoints as Array<{ nodeId: string; actions?: unknown[] }>;
    expect(waypoints.map((w) => w.nodeId)).toEqual(["a", "b", "c"]);
    expect(waypoints[0]!.actions).toMatchObject([{ actionType: "pickTrolley" }]);
    expect(waypoints[1]).not.toHaveProperty("actions");
    expect(waypoints[2]!.actions).toMatchObject([{ actionType: "dropTrolley" }]);
  });

  test("a single-node task runs both ends, pickup first", async () => {
    // Two stations can share an entry node, so a task between them routes
    // to one node. Its role was only ever "pickup": the drop never rode.
    const { base, calls, tasks } = setup({
      poses: new Map([["r1", pose("r1", 0, 0)]]),
      attachments: (_stationId, role) => [
        { actionType: role === "pickup" ? "pickTrolley" : "dropTrolley", blockingType: "HARD" },
      ],
    });
    tasks.set("t1", queued("t1", "A", "A"));
    pumpSiteTasks(base);
    await flush();
    const waypoints = calls[0]!.waypoints as Array<{ nodeId: string; actions?: unknown[] }>;
    expect(waypoints.map((w) => w.nodeId)).toEqual(["a"]);
    expect(waypoints[0]!.actions).toMatchObject([{ actionType: "pickTrolley" }, { actionType: "dropTrolley" }]);
  });

  test("no attachments callback means drive-only tours", async () => {
    const { base, calls, tasks } = setup({ poses: new Map([["r1", pose("r1", 0, 0)]]) });
    tasks.set("t1", queued("t1", "A", "C"));
    pumpSiteTasks(base);
    await flush();
    for (const w of calls[0]!.waypoints) expect(w).not.toHaveProperty("actions");
  });

  test("assigns the nearest free robot along the routed path", async () => {
    const { base, calls, tasks } = setup({
      poses: new Map([
        ["far", pose("far", 0, 0)],
        ["near", pose("near", 9, 0)],
      ]),
    });
    tasks.set("t1", queued("t1", "C", "A"));
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

  test("unknown stations and missing routes fail fast", () => {
    const { base, tasks } = setup({ poses: new Map([["r1", pose("r1", 0, 0)]]) });
    // a node id is not a station
    tasks.set("t1", queued("t1", "a", "C"));
    tasks.set("t2", queued("t2", "A", "C"));
    // ISLAND hangs off a known node with no links: routed, not found
    const island = {
      ...site,
      nodes: [...site.nodes, { id: "island", x: 99, y: 99 }],
      locations: [...site.locations!, { id: "ISLAND", entry: "island", pickPose: { x: 99, y: 98 } }],
    };
    tasks.set("t3", queued("t3", "A", "ISLAND"));
    pumpSiteTasks({ ...base, site: island });
    expect(tasks.get("t1")).toMatchObject({ status: "failed", reason: "unknown pickup or dropoff station" });
    expect(tasks.get("t2")!.status).toBe("assigned");
    expect(tasks.get("t3")).toMatchObject({ status: "failed", reason: expect.stringMatching(/no route/) });
  });

  test("requested tasks wait for a pickup and survive pruning", () => {
    const { base, calls, tasks } = setup({ poses: new Map([["r1", pose("r1", 0, 0)]]) });
    tasks.set("req", { id: "req", dropoff: "C", zone: "dock", status: "requested", createdAt: 1 });
    for (let i = 0; i < MAX_RETAINED_TASKS + 5; i++) {
      tasks.set(`done-${i}`, { ...queued(`done-${i}`), status: "done", createdAt: i });
    }
    pumpSiteTasks(base);
    // invisible to the pump, immune to the prune: not dispatchable yet, never stale
    expect(tasks.get("req")!.status).toBe("requested");
    expect("pickup" in tasks.get("req")!).toBe(false);
    expect(calls).toHaveLength(0);
    expect(tasks.has("req")).toBe(true);
    expect([...tasks.values()].filter((t) => t.status === "done")).toHaveLength(MAX_RETAINED_TASKS);
  });

  test("highest zone demand assigns first even when newer", () => {
    const { base, calls, tasks } = setup({ poses: new Map([["r1", pose("r1", 0, 0)]]) });
    tasks.set("old-plain", { ...queued("old-plain"), createdAt: 1 });
    tasks.set("new-hot", { ...queued("new-hot"), zone: "dock", createdAt: 2 });
    pumpSiteTasks({ ...base, demands: { dock: 5 } });
    expect(tasks.get("new-hot")!.status).toBe("assigned");
    expect(tasks.get("old-plain")!.status).toBe("queued");
    expect(calls).toHaveLength(1);
  });

  test("without demand differences the oldest queued task wins", () => {
    const { base, tasks } = setup({ poses: new Map([["r1", pose("r1", 0, 0)]]) });
    tasks.set("newer", { ...queued("newer"), createdAt: 2 });
    tasks.set("older", { ...queued("older"), createdAt: 1 });
    pumpSiteTasks(base);
    expect(tasks.get("older")!.status).toBe("assigned");
    expect(tasks.get("newer")!.status).toBe("queued");
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

  test("nested pump calls do not recurse once per queued task", () => {
    // dispatch() emits onOrders synchronously, so each assignment calls
    // the pump again from inside itself. With several free robots that
    // nests once per task — 500 queued tasks would be 500 frames deep.
    const tasks = new Map<string, TaskView>();
    const poses = new Map(
      ["r1", "r2", "r3", "r4"].map((s, i) => [s, pose(s, i, 0)] as const),
    );
    const busy = new Set<string>();
    let depth = 0;
    let maxDepth = 0;
    const pump: TaskPump = {
      site,
      poses,
      tasks,
      demands: {},
      poseTtlMs: 30_000,
      fleet: {
        isBusy: (serial) => busy.has(serial),
        dispatch: async (agv) => {
          busy.add(agv.serialNumber);
          depth += 1;
          maxDepth = Math.max(maxDepth, depth);
          pumpSiteTasks(pump); // what onOrders does
          depth -= 1;
          return `order-${agv.serialNumber}`;
        },
      },
    };
    for (const id of ["t1", "t2", "t3", "t4"]) {
      tasks.set(id, { id, pickup: "A", dropoff: "C", status: "queued", createdAt: Date.now() });
    }

    pumpSiteTasks(pump);

    // one walker, however many assignments it makes
    expect(maxDepth).toBe(1);
    // and every task still went out, one per robot
    expect([...tasks.values()].every((t) => t.status === "assigned")).toBe(true);
    expect(new Set([...tasks.values()].map((t) => t.assignee)).size).toBe(4);
  });
});
