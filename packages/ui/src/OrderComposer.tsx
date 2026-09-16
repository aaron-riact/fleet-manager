import React, { useMemo, useState } from "react";
import type { Site } from "@fleet-manager/core";
import type { Backend, LivePose } from "./backend";
import { buildTour } from "./dispatch";
import { theme } from "./theme";

const field: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  margin: "0.35rem 0",
  padding: "0.5rem 0.6rem",
  borderRadius: 10,
  border: `1px solid ${theme.border}`,
  background: theme.bg,
  color: "inherit",
  fontSize: "0.85rem",
};

const submitStyle: React.CSSProperties = {
  width: "100%",
  marginTop: "0.5rem",
  padding: "0.55rem",
  borderRadius: 10,
  border: "none",
  background: `linear-gradient(180deg, #3f8cff, ${theme.accent})`,
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: "0.85rem",
};

/**
 * Station-to-station order composer. Pickup/drop come from the site's
 * locations; the robot picker lists live poses plus free entry.
 * Progress surfaces through the orders feed, not here.
 */
export function OrderComposer({
  site,
  siteName,
  backend,
  poses,
}: {
  site: Site;
  siteName: string;
  backend: Backend;
  poses: Record<string, LivePose>;
}) {
  const stations = useMemo(() => site.locations ?? [], [site]);
  const serials = useMemo(() => Object.keys(poses).sort(), [poses]);
  const [pickupId, setPickupId] = useState("");
  const [dropId, setDropId] = useState("");
  const [serial, setSerial] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const robot = (serial.trim() || serials[0]) ?? "";
  const preview = useMemo(() => {
    const pickup = stations.find((s) => s.id === pickupId);
    const drop = stations.find((s) => s.id === dropId);
    const from = pickup?.pickPose;
    const to = drop?.dropPose ?? drop?.pickPose;
    if (!from || !to) return undefined;
    return buildTour(site.nodes, site.links, from, to);
  }, [stations, pickupId, dropId, site]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!preview || !robot) return;
    setBusy(true);
    setStatus(null);
    try {
      const pose = poses[robot];
      await backend.dispatchOrder(siteName, {
        serialNumber: robot,
        waypoints: preview,
        ...(pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)
          ? { from: { x: pose.x, y: pose.y } }
          : {}),
      });
      setStatus({ ok: true, text: `tour accepted for ${robot}` });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "dispatch failed" });
    } finally {
      setBusy(false);
    }
  }

  if (stations.length === 0) return null;

  return (
    <form
      onSubmit={submit}
      style={{
        background: theme.glass,
        border: `1px solid ${theme.borderSoft}`,
        borderRadius: theme.radius,
        padding: "0.8rem 0.9rem",
        backdropFilter: "blur(8px)",
      }}
    >
      <h2 style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textFaint, margin: "0 0 0.4rem" }}>
        New tour
      </h2>
      <select style={field} value={pickupId} onChange={(e) => setPickupId(e.target.value)}>
        <option value="">Pickup station…</option>
        {stations.filter((s) => s.pickPose).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name ?? s.id}
          </option>
        ))}
      </select>
      <select style={field} value={dropId} onChange={(e) => setDropId(e.target.value)}>
        <option value="">Drop station…</option>
        {stations.filter((s) => s.dropPose ?? s.pickPose).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name ?? s.id}
          </option>
        ))}
      </select>
      <input
        style={field}
        list="composer-robots"
        placeholder={serials[0] ? `Robot (${serials[0]}…)` : "Robot serial…"}
        value={serial}
        onChange={(e) => setSerial(e.target.value)}
      />
      <datalist id="composer-robots">
        {serials.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {preview && (
        <p style={{ color: theme.textFaint, fontSize: "0.75rem", margin: "0.3rem 0" }}>
          via {preview.map((w) => w.nodeId).join(" → ")}
        </p>
      )}
      {pickupId && dropId && !preview && (
        <p style={{ color: theme.warn, fontSize: "0.75rem", margin: "0.3rem 0" }}>no route between stations</p>
      )}
      {status && <p style={{ color: status.ok ? theme.ok : theme.bad, fontSize: "0.8rem" }}>{status.text}</p>}
      <button style={submitStyle} type="submit" disabled={busy || !preview || !robot}>
        {busy ? "Dispatching…" : "Dispatch"}
      </button>
    </form>
  );
}
