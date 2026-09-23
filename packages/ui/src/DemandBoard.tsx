import React, { useEffect, useState } from "react";
import { theme } from "./theme";
import type { SiteLocation, ZoneDemand } from "@fleet-manager/core";
import { useToast } from "./Toast";
import type { Backend } from "./backend";

export interface ZoneRow {
  zone: string;
  demand: number;
  /** Station a request for this zone drops at. Tasks name stations, never nodes. */
  dropStation: string;
  label: string;
}

/**
 * One row per zone: its first station with a drop pose, live demand,
 * +1 tap, request button. Zones list in first-seen location order
 * (authorial, stable). Pure, tested.
 */
export function zoneRows(locations: SiteLocation[], demands: ZoneDemand[]): ZoneRow[] {
  const counts = new Map(demands.map((d) => [d.zone, d.demand]));
  const rows: ZoneRow[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const zone = location.zone;
    if (!zone || seen.has(zone) || !location.dropPose) continue;
    seen.add(zone);
    rows.push({
      zone,
      demand: counts.get(zone) ?? 0,
      dropStation: location.id,
      label: location.name ?? location.id,
    });
  }
  return rows;
}

const cardStyle: React.CSSProperties = {
  background: theme.glass,
  border: `1px solid ${theme.borderSoft}`,
  borderRadius: theme.radius,
  padding: "0.7rem 0.9rem",
  backdropFilter: "blur(8px)",
};

/**
 * Demand signaling for floor staff: tap +1 per zone as need arises,
 * request to convert one unit into a dispatchable job. Big touch
 * targets on purpose — this is the genuinely mobile flow.
 */
export function DemandBoard({
  siteName,
  backend,
  locations,
}: {
  siteName: string;
  backend: Backend;
  locations: SiteLocation[];
}) {
  const [demands, setDemands] = useState<ZoneDemand[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => backend.watchDemands(siteName, setDemands), [backend, siteName]);

  const rows = zoneRows(locations, demands);
  if (rows.length === 0) return null;

  async function bump(zone: string) {
    setBusy(true);
    try {
      await backend.bumpDemand(siteName, { zone, count: 1 });
    } catch (e) {
      toast.show({ kind: "bad", message: e instanceof Error ? e.message : "demand update failed" });
    } finally {
      setBusy(false);
    }
  }

  async function request(row: ZoneRow) {
    setBusy(true);
    try {
      const { taskId } = await backend.submitRequest(siteName, { dropoff: row.dropStation, zone: row.zone });
      toast.show({ kind: "ok", message: `Requested ${row.zone} → ${row.label} (${taskId})` });
    } catch (e) {
      toast.show({ kind: "bad", message: e instanceof Error ? e.message : "request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textFaint, margin: "0 0 0.5rem" }}>
        Demand · {rows.reduce((sum, r) => sum + r.demand, 0)}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {rows.map((row) => (
          <div key={row.zone} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span style={{ fontWeight: 600, fontSize: "0.9rem", flex: 1 }}>{row.zone}</span>
            <span
              style={{
                fontFamily: theme.mono,
                fontSize: "1.1rem",
                color: row.demand > 0 ? theme.warn : theme.textFaint,
                minWidth: "2ch",
                textAlign: "center",
              }}
            >
              {row.demand}
            </span>
            <button
              onClick={() => void bump(row.zone)}
              disabled={busy}
              aria-label={`Add demand for ${row.zone}`}
              style={{
                minWidth: 44,
                minHeight: 44,
                borderRadius: "50%",
                border: `1px solid ${theme.border}`,
                background: "transparent",
                color: theme.text,
                fontSize: "1.2rem",
                cursor: "pointer",
              }}
            >
              +1
            </button>
            <button
              onClick={() => void request(row)}
              disabled={busy}
              style={{
                minHeight: 44,
                padding: "0.4rem 1rem",
                borderRadius: 999,
                border: "none",
                background: `linear-gradient(180deg, #3f8cff, ${theme.accent})`,
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              Request
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
