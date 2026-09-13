import React, { useEffect, useMemo, useRef, useState } from "react";
import { bootFleet } from "./fleet";
import { loopFrom } from "./scenario";
import { watchRobots } from "./robots";
import type { DemoFleet } from "./fleet";
import type { RobotPose } from "./robots";
import { Fleet } from "@fleet-manager/vda";
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
  const [log, setLog] = useState<string[]>([]);
  const [spawnSerial, setSpawnSerial] = useState("demo-3");
  const [status, setStatus] = useState("booting…");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fleet = await bootFleet({
        robots: [
          { manufacturer: MANUFACTURER, serialNumber: "demo-1", x: site.nodes[0]!.x, y: site.nodes[0]!.y },
          { manufacturer: MANUFACTURER, serialNumber: "demo-2", x: site.nodes[3]!.x, y: site.nodes[3]!.y },
        ],
      });
      if (cancelled) {
        await fleet.stop();
        return;
      }
      fleetRef.current = fleet;
      svcRef.current = new Fleet(fleet.master, locksModel, (snap) => {
        if (!cancelled) setLocks(snap);
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
    if (!fleet || !spawnSerial.trim()) return;
    const pad = site.nodes[fleet.robots.length % site.nodes.length]!;
    await fleet.spawn({ manufacturer: MANUFACTURER, serialNumber: spawnSerial.trim(), x: pad.x, y: pad.y });
    setSerials(fleet.robots.map((r) => r.id.serialNumber));
  }

  async function drop(serialNumber: string) {
    const fleet = fleetRef.current;
    if (!fleet) return;
    await fleet.drop(serialNumber);
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
    setStatus(`order running: ${serialNumber}…`);
    try {
      const pose = poses[serialNumber];
      const from =
        pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)
          ? { x: pose.x, y: pose.y }
          : { x: site.nodes[0]!.x, y: site.nodes[0]!.y };
      const tour = loopFrom(
        site.nodes.map((n) => ({ nodeId: n.id, x: n.x, y: n.y })),
        from.x,
        from.y,
      );
      await svc.dispatch(
        robot.id,
        tour.map((w) => ({ nodeId: w.nodeId, x: w.x, y: w.y })),
      );
      setStatus(`order done: ${serialNumber}`);
    } catch (e) {
      console.error("driveLoop failed", e);
      const detail = e instanceof Error ? e.message || String(e) : JSON.stringify(e);
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
              <div key={s} style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "0.25rem 0" }}>
                <code>{s}</code>
                <span style={{ color: "#8b949e", fontSize: "0.8rem" }}>
                  {poses[s] ? `${poses[s]!.x.toFixed(1)}, ${poses[s]!.y.toFixed(1)}` : "…"}
                </span>
                <button onClick={() => void driveLoop(s)}>drive loop</button>
                <button onClick={() => void drop(s)}>remove</button>
              </div>
            ))}
            <div style={{ marginTop: "0.5rem" }}>
              <input value={spawnSerial} onChange={(e) => setSpawnSerial(e.target.value)} placeholder="serial" />
              <button onClick={() => void spawn()}>spawn</button>
            </div>
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
