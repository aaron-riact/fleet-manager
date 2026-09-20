import React, { useEffect, useMemo, useRef, useState } from "react";
import { bootFleet } from "./fleet";
import { loopFrom } from "./scenario";
import { watchConnections, watchRobots } from "@fleet-manager/vda";
import { addDemand, checkNode, checkRoutePair, consumeDemand, demandList, freeSpot, nextTaskId, occupiedSpots, pumpSiteTasks } from "@fleet-manager/core";
import { diffLocks, formatLockEvent } from "./lockEvents";
import type { DemoFleet } from "./fleet";
import type { RobotConnection, RobotPose } from "@fleet-manager/vda";
import { Fleet } from "@fleet-manager/vda";
import type { ActiveOrder } from "@fleet-manager/vda";
import { App } from "@fleet-manager/ui";
import { createMemoryBackend } from "./memoryBackend";
import type { MemoryBackend } from "./memoryBackend";
import siteData from "../../../data/seed/sites/demo.json";
import { buildLocks } from "@fleet-manager/core";
import type { DemandCounts, LockSnapshot, Site, TaskView } from "@fleet-manager/core";
import { POSE_TTL_MS } from "@fleet-manager/ui";

declare const __BUILD_ID__: string;

const site = siteData as Site;
const MANUFACTURER = "RobotCompany";

const panel: React.CSSProperties = {
  background: "#11161f",
  border: "1px solid #232b38",
  borderRadius: 12,
  padding: "1rem",
};

export default function Director() {
  const fleetRef = useRef<DemoFleet | null>(null);
  const svcRef = useRef<Fleet | null>(null);
  const locksModel = useMemo(() => buildLocks(site as Site), []);
  const posesRef = useRef<Record<string, RobotPose>>({});
  const seenRef = useRef<Record<string, number>>({});
  const tasksRef = useRef(new Map<string, TaskView>());
  const demandsRef = useRef<DemandCounts>({});
  const parkedRef = useRef<Record<string, string>>({});
  function pumpDemoTasks() {
    const svc = svcRef.current;
    if (!svc) return;
    const poses = new Map(
      Object.entries(posesRef.current).map(([serial, p]) => [
        serial,
        {
          manufacturer: p.manufacturer,
          x: p.x,
          y: p.y,
          seenAt: seenRef.current[serial] ?? 0,
        },
      ]),
    );
    pumpSiteTasks({ site: site as Site, fleet: svc, poses, tasks: tasksRef.current, demands: demandsRef.current, poseTtlMs: POSE_TTL_MS });
  }
  const [backend] = useState<MemoryBackend>(() =>
    createMemoryBackend(site as Site, {
      dispatchOrder: async (_site, input) => {
        const svc = svcRef.current;
        const fleet = fleetRef.current;
        if (!svc || !fleet) throw new Error("fleet not booted yet");
        const robot = fleet.robots.find((r) => r.id.serialNumber === input.serialNumber);
        if (!robot) throw new Error(`unknown robot "${input.serialNumber}"`);
        const pose = posesRef.current[input.serialNumber];
        await svc.dispatch(
          robot.id,
          input.waypoints.map((w) => ({ nodeId: w.nodeId, x: w.x, y: w.y })),
          {
            ...(pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)
              ? { from: { x: pose.x, y: pose.y } }
              : {}),
          },
        );
      },
      parkRobot: async (_site, input) => {
        const svc = svcRef.current;
        const fleet = fleetRef.current;
        if (!svc || !fleet) throw new Error("fleet not booted yet");
        const robot = fleet.robots.find((r) => r.id.serialNumber === input.serialNumber);
        if (!robot) throw new Error(`unknown robot "${input.serialNumber}"`);
        const pose = posesRef.current[input.serialNumber];
        const spots = (site as Site).parking ?? [];
        const spot = input.spotId
          ? spots.find((s) => s.id === input.spotId)
          : freeSpot(spots, parkedRef.current, pose);
        if (!spot) throw new Error("no free parking spot");
        await svc.park(
          robot.id,
          spot,
          pose && Number.isFinite(pose.x) && Number.isFinite(pose.y) ? { from: pose } : {},
        );
        return { spot: spot.id };
      },
      cancelOrder: async (_site, input) => {
        const svc = svcRef.current;
        const fleet = fleetRef.current;
        if (!svc || !fleet) throw new Error("fleet not booted yet");
        const robot = fleet.robots.find((r) => r.id.serialNumber === input.serialNumber);
        if (!robot) throw new Error(`unknown robot "${input.serialNumber}"`);
        await svc.cancel(robot.id);
      },
      submitTask: async (_site, input) => {
        const svc = svcRef.current;
        if (!svc) throw new Error("fleet not booted yet");
        const demoSite = site as Site;
        const issue = checkRoutePair(demoSite, input.pickup, input.dropoff);
        if (issue) throw new Error(issue.message);
        const id = nextTaskId();
        tasksRef.current.set(id, {
          id,
          pickup: input.pickup,
          dropoff: input.dropoff,
          status: "queued",
          createdAt: Date.now(),
        });
        pumpDemoTasks();
        return { taskId: id };
      },
      listTasks: async () => [...tasksRef.current.values()],
      withdrawTask: async (_site, taskId) => {
        const task = tasksRef.current.get(taskId);
        if (!task) throw new Error("unknown task");
        if (task.status === "requested") {
          if (task.zone !== undefined) {
            demandsRef.current = addDemand(demandsRef.current, task.zone, 1);
            backend.emitDemands(demandList(demandsRef.current));
          }
          tasksRef.current.delete(taskId);
          return;
        }
        if (task.status !== "queued") throw new Error("only queued tasks can be withdrawn");
        tasksRef.current.delete(taskId);
      },
      submitRequest: async (_site, input) => {
        const svc = svcRef.current;
        if (!svc) throw new Error("fleet not booted yet");
        const demoSite = site as Site;
        const dropoffIssue = checkNode(demoSite, "dropoff", input.dropoff);
        if (dropoffIssue) throw new Error(dropoffIssue.message);
        if (input.zone !== undefined && !input.zone) {
          throw new Error("zone must be a non-empty string");
        }
        const id = nextTaskId();
        tasksRef.current.set(id, {
          id,
          dropoff: input.dropoff,
          ...(input.zone === undefined ? {} : { zone: input.zone }),
          status: "requested",
          createdAt: Date.now(),
        });
        if (input.zone !== undefined) {
          demandsRef.current = consumeDemand(demandsRef.current, input.zone);
          backend.emitDemands(demandList(demandsRef.current));
        }
        return { taskId: id };
      },
      attachPickup: async (_site, taskId, input) => {
        const task = tasksRef.current.get(taskId);
        if (!task) throw new Error("unknown task");
        if (task.status !== "requested") throw new Error("only requested tasks take a pickup");
        const demoSite = site as Site;
        const pickupIssue = checkNode(demoSite, "pickup", input.pickup);
        if (pickupIssue) throw new Error(pickupIssue.message);
        const routeIssue = checkRoutePair(demoSite, input.pickup, task.dropoff);
        if (routeIssue) throw new Error(routeIssue.message);
        task.pickup = input.pickup;
        task.status = "queued";
        pumpDemoTasks();
      },
      bumpDemand: async (_site, input) => {
        if (!input.zone) throw new Error("zone required");
        if (!Number.isInteger(input.count) || input.count < 0) {
          throw new Error("count must be a non-negative integer");
        }
        demandsRef.current = addDemand(demandsRef.current, input.zone, input.count);
        backend.emitDemands(demandList(demandsRef.current));
        return { zone: input.zone, demand: demandsRef.current[input.zone]! };
      },
      parkRobots: async (_site, input) => {
        const svc = svcRef.current;
        const fleet = fleetRef.current;
        if (!svc || !fleet) throw new Error("fleet not booted yet");
        const now = Date.now();
        const spots = ((site as Site).parking ?? []).filter(
          (s) => input.zone === undefined || s.zone === input.zone,
        );
        const live = Object.values(posesRef.current).filter(
          (p) =>
            Number.isFinite(p.x) &&
            Number.isFinite(p.y) &&
            now - (seenRef.current[p.serialNumber] ?? 0) < POSE_TTL_MS,
        );
        const occupied = occupiedSpots(spots, live);
        const taken = new Set<string>();
        const parked: Array<{ serialNumber: string; spot: string }> = [];
        const failed: Array<{ serialNumber: string; error: string }> = [];
        for (const serialNumber of input.serialNumbers) {
          const pose = posesRef.current[serialNumber];
          if (!pose || !live.includes(pose)) {
            failed.push({ serialNumber, error: "no recent pose for robot" });
            continue;
          }
          const robot = fleet.robots.find((r) => r.id.serialNumber === serialNumber);
          if (!robot) {
            failed.push({ serialNumber, error: "unknown robot" });
            continue;
          }
          const spot = freeSpot(
            spots.filter((s) => !taken.has(s.id)),
            occupied,
            pose,
          );
          if (!spot) {
            failed.push({ serialNumber, error: "no free parking spot" });
            continue;
          }
          taken.add(spot.id);
          // Accepted, not awaited — same fire-and-forget as the server.
          svc.park(robot.id, spot, { from: pose }).catch((e: unknown) => console.warn("park failed", e));
          parked.push({ serialNumber, spot: spot.id });
        }
        return { parked, failed };
      },
    }),
  );
  const [serials, setSerials] = useState<string[]>([]);
  const [poses, setPoses] = useState<Record<string, RobotPose>>({});
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  // parking spot id -> serial; idle robots live here, off the graph
  const [parked, setParked] = useState<Record<string, string>>({});
  parkedRef.current = parked;
  const [log, setLog] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const prevLocks = useRef<LockSnapshot | undefined>(undefined);
  const [spawnSerial, setSpawnSerial] = useState("demo-3");
  const [status, setStatus] = useState("booting…");
  const [robotStatus, setRobotStatus] = useState<Record<string, string>>({});

  const setRobot = (serialNumber: string, s: string) =>
    setRobotStatus((prev) => ({ ...prev, [serialNumber]: s }));

  useEffect(() => {
    let cancelled = false;
    let stopConns: (() => void) | undefined;
    (async () => {
      const spots = site.parking ?? [];
      const fleet = await bootFleet({
        robots: [
          { manufacturer: MANUFACTURER, serialNumber: "demo-1", x: spots[0]?.x ?? 0, y: spots[0]?.y ?? 0 },
          { manufacturer: MANUFACTURER, serialNumber: "demo-2", x: spots[1]?.x ?? 0, y: spots[1]?.y ?? 0 },
        ],
      });
      if (cancelled) {
        await fleet.stop();
        return;
      }
      setParked({
        ...(spots[0] ? { [spots[0].id]: "demo-1" } : {}),
        ...(spots[1] ? { [spots[1].id]: "demo-2" } : {}),
      });
      fleetRef.current = fleet;
      const svc = new Fleet(fleet.master, locksModel, {
        onLocks: (snap) => {
          if (cancelled) return;
          backend.emitLocks(snap);
          for (const line of diffLocks(prevLocks.current, snap).map(formatLockEvent)) {
            setEvents((prev) => [...prev.slice(-49), line]);
          }
          prevLocks.current = snap;
        },
        onArrived: (serial, nodeId, index) => {
          if (cancelled) return;
          setEvents((prev) => [...prev.slice(-49), `${serial} at ${nodeId} (${index})`]);
        },
        onOrders: (list) => {
          if (cancelled) return;
          backend.emitOrders(list);
          setOrders(list);
          pumpDemoTasks();
        },
        onHistory: (history) => {
          if (cancelled) return;
          backend.emitHistory(history);
        },
      });
      svcRef.current = svc;
      setSerials(fleet.robots.map((r) => r.id.serialNumber));
      await watchRobots(fleet.master, MANUFACTURER, (pose) => {
        if (cancelled) return;
        posesRef.current = { ...posesRef.current, [pose.serialNumber]: pose };
        seenRef.current[pose.serialNumber] = Date.now();
        backend.emitPose(pose);
        setPoses((prev) => ({ ...prev, [pose.serialNumber]: pose }));
      });
      const conns: Record<string, RobotConnection> = {};
      stopConns = watchConnections(fleet.master, (conn) => {
        if (cancelled) return;
        conns[conn.serialNumber] = conn;
        backend.emitConnections(Object.values(conns));
      });
      fleet.hub.subscribe("#", (topic) => {
        if (cancelled || /\/state$/.test(topic)) return;
        setLog((prev) => [...prev.slice(-119), topic]);
      });
      if (!cancelled) setStatus("running");
    })().catch((e) => !cancelled && setStatus(`boot failed: ${(e as Error).message}`));
    return () => {
      cancelled = true;
      stopConns?.();
      fleetRef.current?.stop().catch(() => {});
      fleetRef.current = null;
    };
  }, []);

  async function spawn() {
    const fleet = fleetRef.current;
    const serial = spawnSerial.trim();
    if (!fleet || !serial) return;
    const spot = freeSpot(site.parking ?? [], parked);
    if (!spot) {
      setStatus("no free parking spot");
      return;
    }
    await fleet.spawn({ manufacturer: MANUFACTURER, serialNumber: serial, x: spot.x, y: spot.y });
    setParked((prev) => ({ ...prev, [spot.id]: serial }));
    setSerials(fleet.robots.map((r) => r.id.serialNumber));
  }

  function unpark(serialNumber: string) {
    setParked((prev) => {
      const next = { ...prev };
      for (const [spot, who] of Object.entries(next)) if (who === serialNumber) delete next[spot];
      return next;
    });
  }

  async function drop(serialNumber: string) {
    const fleet = fleetRef.current;
    if (!fleet) return;
    await fleet.drop(serialNumber);
    unpark(serialNumber);
    setSerials(fleet.robots.map((r) => r.id.serialNumber));
    setPoses((prev) => {
      const next = { ...prev };
      delete next[serialNumber];
      return next;
    });
  }

  async function driveLoop(serialNumber: string) {
    const fleet = fleetRef.current;
    const svc = svcRef.current;
    const robot = fleet?.robots.find((r) => r.id.serialNumber === serialNumber);
    if (!fleet || !svc || !robot) return;
    setRobot(serialNumber, "starting…");
    setStatus(`order running: ${serialNumber}…`);
    try {
      // Leaving parking: the spot frees up the moment the tour starts.
      unpark(serialNumber);
      // Tour starts at the nearest node, but the deviation check needs the
      // robot's real pose (usually a parking spot), not the tour start.
      const spotId = Object.entries(parked).find(([, who]) => who === serialNumber)?.[0];
      const homeSpot = (site.parking ?? []).find((s) => s.id === spotId);
      const pose = poses[serialNumber];
      const home =
        (pose && Number.isFinite(pose.x) && Number.isFinite(pose.y) ? pose : undefined) ??
        homeSpot ??
        site.nodes[0]!;
      // Tour starts at the nearest node — sharing entries is what makes
      // followers queue and trail the leader through the same nodes.
      const tour = loopFrom(
        site.nodes.map((n) => ({ nodeId: n.id, x: n.x, y: n.y })),
        home.x,
        home.y,
      );
      // Claim the exit BEFORE dispatching. The tour and the park leg go out
      // as one order so the locker knows we leave the graph at the end —
      // otherwise it must assume we stop on the ring and keep the whole
      // bidirectional run clear, which shuts every follower out.
      const last = tour[tour.length - 1]!;
      // Occupancy without self (already unparked above; closure is stale).
      const free: Record<string, string> = {};
      for (const [spotId, who] of Object.entries(parked)) {
        if (who !== serialNumber) free[spotId] = who;
      }
      const spot = freeSpot(site.parking ?? [], free, last);
      if (spot) {
        setParked((prev) => ({ ...prev, [spot.id]: serialNumber }));
        setRobot(serialNumber, `tour → park ${spot.id}…`);
      }
      try {
        await svc.dispatch(
          robot.id,
          tour.map((w) => ({ nodeId: w.nodeId, x: w.x, y: w.y })),
          { from: home, park: spot },
        );
      } catch (e) {
        // Release the reservation we took above, or the spot leaks.
        if (spot) unpark(serialNumber);
        throw e;
      }
      setRobot(serialNumber, "done");
      setStatus(`order done: ${serialNumber}`);
    } catch (e) {
      console.error("driveLoop failed", e);
      const detail = e instanceof Error ? e.message || String(e) : JSON.stringify(e);
      setRobot(serialNumber, `failed: ${detail.slice(0, 120)}`);
      setStatus(`order failed: ${detail}`);
    }
  }

  return (
    <App
      sessionOverride={{ token: "demo", username: "demo", sites: [(site as Site).name] }}
      createBackend={() => backend}
      extraPanel={
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1rem" }}>
          <section style={panel}>
            <h2 style={{ marginTop: 0 }}>
              Director{" "}
              <span style={{ fontSize: "0.7rem", color: "#8b949e", fontWeight: "normal" }}>
                serverless · {status} · build {__BUILD_ID__}
              </span>
            </h2>
            <h3 style={{ fontSize: "0.85rem", color: "#8b949e" }}>Robots</h3>
            {serials.map((s) => (
              <React.Fragment key={s}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "0.25rem 0" }}>
                  <code>{s}</code>
                  <span style={{ color: "#8b949e", fontSize: "0.8rem" }}>
                    {poses[s] ? `${poses[s]!.x.toFixed(1)}, ${poses[s]!.y.toFixed(1)}` : "…"}
                  </span>
                  <button onClick={() => void driveLoop(s)}>drive loop</button>
                  <button onClick={() => void drop(s)}>remove</button>
                </div>
                {robotStatus[s] && (
                  <div style={{ fontSize: "0.75rem", color: "#8b949e", margin: "-0.1rem 0 0.25rem 0" }}>
                    {robotStatus[s]}
                  </div>
                )}
              </React.Fragment>
            ))}
            <div style={{ marginTop: "0.5rem" }}>
              <input value={spawnSerial} onChange={(e) => setSpawnSerial(e.target.value)} placeholder="serial" />
              <button onClick={() => void spawn()}>spawn</button>
            </div>
          </section>
          <section style={panel}>
            <h2 style={{ marginTop: 0 }}>Orders</h2>
            {orders.length === 0 && <p style={{ color: "#8b949e" }}>none active</p>}
            {orders.map((o) => (
              <div key={o.orderId} style={{ margin: "0.25rem 0", fontSize: "0.8rem" }}>
                <code>{o.serial}</code>{" "}
                <span style={{ color: "#8b949e" }}>
                  {o.orderId} · u{o.updateId}
                </span>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                  {o.nodes.map((n, i) => (
                    <span
                      key={`${n.nodeId}-${i}`}
                      style={{
                        padding: "0 6px",
                        borderRadius: 8,
                        border: "1px solid #232b38",
                        background: n.released ? "#1a7f3722" : "transparent",
                        color: n.released ? "#7ee787" : "#8b949e",
                      }}
                    >
                      {n.nodeId}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </section>
          <section style={panel}>
            <h2 style={{ marginTop: 0 }}>
              Lock events{" "}
              <label style={{ fontSize: "0.7rem", color: "#8b949e", fontWeight: "normal" }}>
                <input
                  type="checkbox"
                  checked={showAllEvents}
                  onChange={(e) => setShowAllEvents(e.target.checked)}
                />{" "}
                all
              </label>
            </h2>
            <pre style={{ maxHeight: 200, overflow: "auto", fontSize: "0.75rem", color: "#8b949e" }}>
              {(showAllEvents ? events : events.filter((l) => /waits on|stops waiting/.test(l))).join("\n") ||
                "no lock activity yet"}
            </pre>
          </section>
          <section style={panel}>
            <h2 style={{ marginTop: 0 }}>Bus topics</h2>
            <pre style={{ maxHeight: 200, overflow: "auto", fontSize: "0.75rem", color: "#8b949e" }}>
              {log.join("\n") || "no non-state traffic yet"}
            </pre>
          </section>
        </div>
      }
    />
  );
}
