import React, { useEffect, useMemo, useRef, useState } from "react";
import { bootFleet } from "./fleet";
import { loopFrom } from "./scenario";
import { watchConnections, watchRobots } from "@fleet-manager/vda";
import { addDemand, checkNode, checkRoutePair, consumeDemand, demandList, freeSpot, nextTaskId, occupiedSpots, parkRoute, pumpSiteTasks } from "@fleet-manager/core";
import { diffLocks, formatLockEvent } from "./lockEvents";
import type { DemoFleet } from "./fleet";
import type { RobotConnection, RobotPose } from "@fleet-manager/vda";
import { Fleet } from "@fleet-manager/vda";
import type { ActiveOrder } from "@fleet-manager/vda";
import { App, hashFor, parseHash } from "@fleet-manager/ui";
import { createMemoryBackend } from "./memoryBackend";
import type { MemoryBackend } from "./memoryBackend";
import { defaultActionLabel } from "@fleet-manager/ui";
import type { MapMarker } from "@fleet-manager/ui";
import { selectAutoParkTarget } from "./autoPark";
import { TrolleyAdapter } from "./trolley/adapter";
import { dropAttachments, pickAttachments, stationDock, stationEntry } from "./trolley/attachments";
import { DEFAULT_TROLLEY_SEED, TrolleyWorld } from "./trolley/world";
import { SITES, selectInitialSite } from "./sites";
import { buildLocks } from "@fleet-manager/core";
import type { DemandCounts, LockSnapshot, Site, TaskView } from "@fleet-manager/core";
import { POSE_TTL_MS } from "@fleet-manager/ui";

declare const __BUILD_ID__: string;

const MANUFACTURER = "RobotCompany";

const panel: React.CSSProperties = {
  background: "#11161f",
  border: "1px solid #232b38",
  borderRadius: 12,
  padding: "1rem",
};

/** FLEET_SITE is read through Vite's env allowlist (see vite.config.ts envPrefix). */
function envSite(): string | undefined {
  const value = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.FLEET_SITE;
  return value && SITES[value] ? value : undefined;
}

function hashSite(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const site = parseHash(window.location.hash).site;
  return site && SITES[site] ? site : undefined;
}

function navigateSite(name: string): void {
  // Preserve the shell/tab route, swapping only the site: refresh and
  // back/forward then keep the full view state, not just the map.
  const route = parseHash(window.location.hash);
  window.location.hash = hashFor({ ...route, site: name });
}

export default function Director() {
  // Hash is the source of truth after boot: the in-app switcher writes
  // it (via onNavigate), this listener remounts the world for it, and
  // App's own shell/tab routes ride along untouched inside the same hash.
  const [siteName, setSiteName] = useState(() => hashSite() ?? envSite() ?? selectInitialSite());
  useEffect(() => {
    const onChange = () => {
      const next = hashSite() ?? envSite() ?? selectInitialSite();
      setSiteName((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return <DirectorWorld key={siteName} siteName={siteName} onNavigate={navigateSite} />;
}

function DirectorWorld({ siteName, onNavigate }: { siteName: string; onNavigate: (name: string) => void }) {
  const site = SITES[siteName]!;

  const fleetRef = useRef<DemoFleet | null>(null);
  const worldRef = useRef<TrolleyWorld | null>(null);
  const svcRef = useRef<Fleet | null>(null);
  const locksModel = useMemo(() => buildLocks(site as Site), []);
  const posesRef = useRef<Record<string, RobotPose>>({});
  const seenRef = useRef<Record<string, number>>({});
  const tasksRef = useRef(new Map<string, TaskView>());
  const demandsRef = useRef<DemandCounts>({});
  const parkedRef = useRef<Record<string, string>>({});
  // Spot ids already targeted by in-flight auto-parks. Park resolves on
  // arrival, so without this two completions could aim two robots at the
  // same spot.
  const parkingTargetsRef = useRef(new Map<string, string>());
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
    pumpSiteTasks({
      site: site as Site,
      fleet: svc,
      poses,
      tasks: tasksRef.current,
      demands: demandsRef.current,
      poseTtlMs: POSE_TTL_MS,
      // Trolley work rides the tour ends; plain graph nodes stay drive-only.
      attachments: (nodeId, role) =>
        role === "pickup" ? pickAttachments(site as Site, nodeId) : dropAttachments(site as Site, nodeId),
    });
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
        // Manual tours name their stations; work attaches at the waypoints
        // matching those stations' entries — NOT at the tour ends, which
        // start at the node nearest the robot. A doomed drop (station
        // occupied) refuses before driving; an empty pick station still
        // drives and fails on arrival, where the world is actually read.
        const demoSite = site as Site;
        const world = worldRef.current;
        const pickEntry = input.pickupStationId ? stationEntry(demoSite, input.pickupStationId) : undefined;
        const dropEntry = input.dropStationId ? stationEntry(demoSite, input.dropStationId) : undefined;
        if (input.dropStationId && world) {
          const occupant = world.trolleyAt(input.dropStationId);
          if (occupant !== undefined) {
            throw new Error(`station "${input.dropStationId}" already holds trolley "${occupant}"`);
          }
        }
        const pickAt = pickEntry === undefined ? -1 : input.waypoints.findIndex((w) => w.nodeId === pickEntry);
        let dropAt = -1;
        if (dropEntry !== undefined) {
          for (let i = input.waypoints.length - 1; i >= 0; i--) {
            if (input.waypoints[i]!.nodeId === dropEntry) {
              dropAt = i;
              break;
            }
          }
        }
        await svc.dispatch(
          robot.id,
          input.waypoints.map((w, i) => {
            const actions = [
              ...(i === pickAt ? pickAttachments(demoSite, w.nodeId) : []),
              ...(i === dropAt ? dropAttachments(demoSite, w.nodeId) : []),
            ];
            return actions.length > 0
              ? { nodeId: w.nodeId, x: w.x, y: w.y, actions }
              : { nodeId: w.nodeId, x: w.x, y: w.y };
          }),
          {
            ...(pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)
              ? { from: { x: pose.x, y: pose.y } }
              : {}),
            ...(input.exit ? { exit: input.exit } : {}),
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
    },
    {
      listSites: () => Object.keys(SITES),
      getMap: (name: string) => SITES[name],
      onSelectSite: (name: string) => {
        if (SITES[name] && name !== siteName) onNavigate(name);
      },
    })
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
  const [spawnSerial, setSpawnSerial] = useState(siteName === "coalescent" ? "serena-3" : `${siteName}-3`);
  const [status, setStatus] = useState("booting…");
  const [robotStatus, setRobotStatus] = useState<Record<string, string>>({});

  const setRobot = (serialNumber: string, s: string) =>
    setRobotStatus((prev) => ({ ...prev, [serialNumber]: s }));

  // Trolley markers recompute on every pose update (4Hz): stationed
  // trolleys sit at their dock pose, carried ones follow the robot.
  // The map draws them; only this module knows what they are.
  const markers = useMemo(() => {
    const world = worldRef.current;
    if (!world) return [];
    const out: MapMarker[] = [];
    for (const station of world.stations()) {
      const trolley = world.trolleyAt(station);
      const dock = stationDock(site as Site, station);
      if (!trolley || !dock) continue;
      out.push({ id: `trolley-${trolley}`, x: dock.x, y: dock.y, label: trolley, theta: dock.theta });
    }
    for (const { trolleyId, carrier } of world.aboard()) {
      const pose = poses[carrier];
      if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) continue;
      // Aboard, the trolley rides the robot: same fix, same heading, so
      // the rectangle visibly turns with it (and its orientation can be
      // judged while moving, not just while parked).
      out.push({
        id: `trolley-${trolleyId}`,
        x: pose.x,
        y: pose.y,
        label: trolleyId,
        ...(Number.isFinite(pose.theta) ? { theta: pose.theta } : {}),
      });
    }
    return out;
  }, [poses, site]);

  const resolveActionLabel = useMemo(
    () => (actionType: string) =>
      actionType === "pickTrolley" ? "PICK" : actionType === "dropTrolley" ? "DROP" : defaultActionLabel(actionType),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let stopConns: (() => void) | undefined;
    (async () => {
      const spots = site.parking ?? [];
      // Coalescent robots run as serena-N; other sites keep site-N names.
      const names =
        siteName === "coalescent" ? ["serena-1", "serena-2"] : [`${siteName}-1`, `${siteName}-2`];
      // Sparse initial layout (see DEFAULT_TROLLEY_SEED); the component
      // remounts per site, so each site gets a fresh world. Trolleys are
      // plain trolley-N, parked perpendicular to the dock facing so the
      // maneuver's 90-degree turn lands on the trolley angle.
      const world = new TrolleyWorld();
      const demoSite = site as Site;
      (DEFAULT_TROLLEY_SEED[siteName] ?? []).forEach((station, i) => {
        const dock = stationDock(demoSite, station);
        world.seed(station, `trolley-${i + 1}`, dock?.theta ?? 0);
      });
      worldRef.current = world;
      const fleet = await bootFleet({
        interfaceName: site.name,
        robots: [
          { manufacturer: MANUFACTURER, serialNumber: names[0]!, x: spots[0]?.x ?? 0, y: spots[0]?.y ?? 0 },
          { manufacturer: MANUFACTURER, serialNumber: names[1]!, x: spots[1]?.x ?? 0, y: spots[1]?.y ?? 0 },
        ],
        adapterType: TrolleyAdapter,
        adapterOptions: { world },
      });
      if (cancelled) {
        await fleet.stop();
        return;
      }
      setParked({
        ...(spots[0] ? { [spots[0].id]: names[0]! } : {}),
        ...(spots[1] ? { [spots[1].id]: names[1]! } : {}),
      });
      fleetRef.current = fleet;
      const autoParkAfterTour = (serial: string) => {
        const svc = svcRef.current;
        const liveFleet = fleetRef.current;
        if (cancelled || !svc || !liveFleet) return;
        const robot = liveFleet.robots.find((r) => r.id.serialNumber === serial);
        const pose = posesRef.current[serial];
        if (!robot || !pose) return;
        const spot = selectAutoParkTarget({
          spots: (site as Site).parking ?? [],
          pose: {
            manufacturer: pose.manufacturer,
            x: pose.x,
            y: pose.y,
            seenAt: seenRef.current[serial] ?? 0,
          },
          serialNumber: serial,
          now: Date.now(),
          poseTtlMs: POSE_TTL_MS,
          isBusy: (s) => svc.isBusy(s),
          targetedSpotIds: new Set(parkingTargetsRef.current.values()),
          allPoses: Object.values(posesRef.current).map((p) => ({
            x: p.x,
            y: p.y,
            seenAt: seenRef.current[p.serialNumber] ?? 0,
          })),
        });
        if (!spot) return;
        // Claim the target before driving: spawn and driveLoop both read
        // parkedRef, so an unclaimed target could be double-booked.
        parkingTargetsRef.current.set(serial, spot.id);
        setParked((prev) => ({ ...prev, [spot.id]: serial }));
        // Locked tour to the spot's entry with the parking leg appended
        // (same shape as driveLoop tours), so the robot follows the
        // network instead of free-driving through walls. Falls back to
        // a free-drive park only when no route exists.
        const route = parkRoute(site as Site, pose, spot);
        const ride = route
          ? svc.dispatch(robot.id, route, { from: pose, park: spot })
          : svc.park(robot.id, spot, { from: pose });
        ride
          .catch((error: unknown) => {
            console.warn("auto-park failed", error);
            // Release the reservation we took above, or the spot leaks.
            setParked((prev) => {
              if (prev[spot.id] !== serial) return prev;
              const next = { ...prev };
              delete next[spot.id];
              return next;
            });
          })
          .finally(() => {
            parkingTargetsRef.current.delete(serial);
          });
      };
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
        // Finished generic tours clear the graph into parking, like the
        // server: driveLoop tours already park as part of their own order
        // (and are skipped as already-parked), so this only catches tours
        // from dispatch, tasks, and the order composer.
        onOrderDone: (serial) => {
          if (cancelled) return;
          autoParkAfterTour(serial);
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
      initialSite={siteName}
      markers={markers}
      resolveActionLabel={resolveActionLabel}
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
