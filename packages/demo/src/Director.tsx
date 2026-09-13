import React, { useEffect, useMemo, useRef, useState } from "react";
import { bootFleet } from "./fleet";
import { loopFrom } from "./scenario";
import { watchRobots } from "./robots";
import { freeSpot } from "./parking";
import type { DemoFleet } from "./fleet";
import type { RobotPose } from "./robots";
import { Fleet } from "@fleet-manager/vda";
import type { ActiveOrder } from "@fleet-manager/vda";
import { FleetMap } from "@fleet-manager/ui";
import siteData from "../../../data/seed/sites/coalescent.json";
import { buildLocks } from "@fleet-manager/core";
import type { LockSnapshot, Site } from "@fleet-manager/core";

const site = siteData as Site;
const MANUFACTURER = "RobotCompany";

const page: React.CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  background: "#0b0e14",
  color: "#e6edf3",
  fontFamily: "system-ui, sans-serif",
  padding: "1rem",
};

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
  const [serials, setSerials] = useState<string[]>([]);
  const [poses, setPoses] = useState<Record<string, RobotPose>>({});
  const [locks, setLocks] = useState<LockSnapshot | undefined>(undefined);
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  // parking spot id -> serial; idle robots live here, off the graph
  const [parked, setParked] = useState<Record<string, string>>({});
  const [log, setLog] = useState<string[]>([]);
  const [spawnSerial, setSpawnSerial] = useState("demo-3");
  const [status, setStatus] = useState("booting…");
  const [robotStatus, setRobotStatus] = useState<Record<string, string>>({});

  const setRobot = (serialNumber: string, s: string) =>
    setRobotStatus((prev) => ({ ...prev, [serialNumber]: s }));

  useEffect(() => {
    let cancelled = false;
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
      svcRef.current = new Fleet(fleet.master, locksModel, {
        onLocks: (snap) => {
          if (!cancelled) setLocks(snap);
        },
        onOrders: (list) => {
          if (!cancelled) setOrders(list);
        },
      });
      setSerials(fleet.robots.map((r) => r.id.serialNumber));
      await watchRobots(fleet.master, MANUFACTURER, (pose) => {
        if (cancelled) return;
        setPoses((prev) => ({ ...prev, [pose.serialNumber]: pose }));
      });
      fleet.hub.subscribe("#", (topic) => {
        if (cancelled || /\/state$/.test(topic)) return;
        setLog((prev) => [...prev.slice(-119), topic]);
      });
      if (!cancelled) setStatus("running");
    })().catch((e) => !cancelled && setStatus(`boot failed: ${(e as Error).message}`));
    return () => {
      cancelled = true;
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
      await svc.dispatch(
        robot.id,
        tour.map((w) => ({ nodeId: w.nodeId, x: w.x, y: w.y })),
        { from: home },
      );
      const last = tour[tour.length - 1]!;
      // Occupancy without self (already unparked above; closure is stale).
      const free: Record<string, string> = {};
      for (const [spotId, who] of Object.entries(parked)) {
        if (who !== serialNumber) free[spotId] = who;
      }
      const spot = freeSpot(site.parking ?? [], free, last);
      if (spot) {
        setRobot(serialNumber, `parking → ${spot.id}…`);
        setStatus(`parking: ${serialNumber} → ${spot.id}…`);
        await svc.park(robot.id, spot, { from: last });
        setParked((prev) => ({ ...prev, [spot.id]: serialNumber }));
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
    <div style={page}>
      <header style={{ display: "flex", gap: "1rem", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Fleet Demo</h1>
        <span style={{ color: "#8b949e" }}>serverless · {status}</span>
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1rem", marginTop: "1rem" }}>
        <FleetMap
          site={site}
          locks={locks}
          parking={site.parking ?? []}
          waits={orders.flatMap((o) => {
            const next = o.nodes.find((n) => !n.released);
            return next ? [{ serialNumber: o.serial, nodeId: next.nodeId }] : [];
          })}
          robots={serials.map((s) => ({
            serialNumber: s,
            x: poses[s]?.x ?? Number.NaN,
            y: poses[s]?.y ?? Number.NaN,
          }))}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <section style={panel}>
            <h2 style={{ marginTop: 0 }}>Robots</h2>
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
            <h2 style={{ marginTop: 0 }}>Bus topics</h2>
            <pre style={{ maxHeight: 200, overflow: "auto", fontSize: "0.75rem", color: "#8b949e" }}>
              {log.join("\n")}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}
