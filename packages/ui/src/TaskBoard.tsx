import React, { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import { useToast } from "./Toast";
import { touchStyle, useNarrow } from "./responsive";
import type { Backend } from "./backend";
import type { SiteLocation, TaskView } from "@fleet-manager/core";

function taskColor(status: TaskView["status"]): string {
  switch (status) {
    case "done":
      return theme.ok;
    case "assigned":
      return theme.accent;
    case "failed":
      return theme.bad;
    case "requested":
      return theme.warn;
    case "queued":
      return theme.textDim;
  }
}

const cardStyle: React.CSSProperties = {
  background: theme.glass,
  border: `1px solid ${theme.borderSoft}`,
  borderRadius: theme.radius,
  padding: "0.7rem 0.9rem",
  backdropFilter: "blur(8px)",
};

export interface StationOption {
  id: string;
  label: string;
}

/**
 * The stations a task may pick from and drop at. Tasks name stations,
 * never nodes, and a station without the matching pose has no work to do
 * in that role, so it is left out. Pure, tested.
 */
export function taskStations(stations: SiteLocation[]): { pickups: StationOption[]; dropoffs: StationOption[] } {
  const option = (s: SiteLocation): StationOption => ({ id: s.id, label: s.name ?? s.id });
  return {
    pickups: stations.filter((s) => s.pickPose !== undefined).map(option),
    dropoffs: stations.filter((s) => s.dropPose !== undefined).map(option),
  };
}

const select: React.CSSProperties = {
  flex: "1 1 0",
  minWidth: 0,
  padding: "0.4rem 0.5rem",
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: theme.bg,
  color: "inherit",
  fontSize: "0.8rem",
};

/** Pickup select plus attach button for a requested task. */
function AttachPickup({
  pickups,
  busy,
  onAttach,
}: {
  pickups: StationOption[];
  busy: boolean;
  onAttach: (pickup: string) => void;
}) {
  const [pickup, setPickup] = useState(pickups[0]?.id ?? "");
  return (
    <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center", marginLeft: "auto" }}>
      <select
        aria-label="Pickup station"
        value={pickup}
        onChange={(e) => setPickup(e.target.value)}
        style={{ padding: "0.3rem 0.4rem", borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.bg, color: "inherit", fontSize: "0.75rem" }}
      >
        {pickups.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        onClick={() => pickup && onAttach(pickup)}
        disabled={busy || !pickup}
        style={{ padding: "0.3rem 0.7rem", borderRadius: 999, border: "none", background: `linear-gradient(180deg, #3f8cff, ${theme.accent})`, color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.75rem" }}
      >
        Attach
      </button>
    </span>
  );
}

/** Pickup→dropoff jobs between stations: submit, watch the queue. */
export function TaskBoard({
  siteName,
  backend,
  stations,
}: {
  siteName: string;
  backend: Backend;
  stations: SiteLocation[];
}) {
  const { pickups, dropoffs } = taskStations(stations);
  const labelOf = (id: string) => stations.find((s) => s.id === id)?.name ?? id;
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [pickup, setPickup] = useState(pickups[0]?.id ?? "");
  const [dropoff, setDropoff] = useState(dropoffs[1]?.id ?? dropoffs[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const narrow = useNarrow();

  const refresh = useCallback(async () => {
    try {
      setTasks(await backend.listTasks(siteName));
    } catch {
      /* keep the last snapshot on transient failures */
    }
  }, [backend, siteName]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!pickup || !dropoff || busy) return;
    setBusy(true);
    try {
      const { taskId } = await backend.submitTask(siteName, { pickup, dropoff });
      toast.show({ kind: "ok", message: `Task ${taskId} queued (${labelOf(pickup)} → ${labelOf(dropoff)})` });
      await refresh();
    } catch (e) {
      toast.show({ kind: "bad", message: e instanceof Error ? e.message : "submit failed" });
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(taskId: string) {
    try {
      await backend.withdrawTask(siteName, taskId);
      toast.show({ kind: "info", message: `Task ${taskId} withdrawn` });
      await refresh();
    } catch (e) {
      toast.show({ kind: "bad", message: e instanceof Error ? e.message : "withdraw failed" });
    }
  }

  async function attach(taskId: string, pickup: string) {
    setBusy(true);
    try {
      await backend.attachPickup(siteName, taskId, { pickup });
      toast.show({ kind: "ok", message: `Task ${taskId} queued from ${labelOf(pickup)}` });
      await refresh();
    } catch (e) {
      toast.show({ kind: "bad", message: e instanceof Error ? e.message : "attach failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textFaint, margin: "0 0 0.5rem" }}>
        Tasks · {tasks.length}
      </h2>
      <form style={cardStyle} onSubmit={submit}>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <select aria-label="Pickup station" style={select} value={pickup} onChange={(e) => setPickup(e.target.value)}>
            {pickups.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <span style={{ color: theme.textFaint, alignSelf: "center" }}>→</span>
          <select aria-label="Dropoff station" style={select} value={dropoff} onChange={(e) => setDropoff(e.target.value)}>
            {dropoffs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !pickup || !dropoff}
            style={{
              padding: "0.4rem 0.8rem",
              borderRadius: 8,
              border: "none",
              background: `linear-gradient(180deg, #3f8cff, ${theme.accent})`,
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "0.8rem",
              ...touchStyle(narrow),
            }}
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
      </form>
      {tasks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.5rem" }}>
          {tasks.map((t) => (
            <div key={t.id} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", flexWrap: "wrap" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: taskColor(t.status), flexShrink: 0 }} />
              <span style={{ fontFamily: theme.mono }}>
                {t.pickup === undefined ? "?" : labelOf(t.pickup)} → {labelOf(t.dropoff)}
              </span>
              <span style={{ color: theme.textDim }}>{t.status}</span>
              {t.assignee && <span style={{ color: theme.textFaint, fontSize: "0.72rem" }}>{t.assignee}</span>}
              {t.reason && <span style={{ color: theme.bad, fontSize: "0.72rem" }}>{t.reason}</span>}
              {t.status === "requested" && (
                <AttachPickup
                  pickups={pickups}
                  busy={busy}
                  onAttach={(pickup) => void attach(t.id, pickup)}
                />
              )}
              {(t.status === "queued" || t.status === "requested") && (
                <button
                  onClick={() => void withdraw(t.id)}
                  style={{
                    marginLeft: "auto",
                    padding: "0.2rem 0.6rem",
                    borderRadius: 999,
                    border: `1px solid ${theme.border}`,
                    background: "transparent",
                    color: theme.textDim,
                    cursor: "pointer",
                    fontSize: "0.72rem",
                    ...touchStyle(narrow),
                  }}
                >
                  Withdraw
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
