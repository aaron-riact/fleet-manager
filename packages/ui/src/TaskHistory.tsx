import React, { useMemo, useState } from "react";
import { theme } from "./theme";
import type { HistoryView } from "./backend";

export type HistoryFilter = HistoryView["outcome"] | "all";

/** Newest first; the stream already arrives newest first, this is defensive. Pure, tested. */
export function selectHistory(history: HistoryView[], filter: HistoryFilter): HistoryView[] {
  return history
    .filter((h) => filter === "all" || h.outcome === filter)
    .slice()
    .sort((a, b) => b.finishedAt - a.finishedAt);
}

export function outcomeColor(outcome: HistoryView["outcome"]): string {
  switch (outcome) {
    case "completed":
      return theme.ok;
    case "cancelled":
      return theme.warn;
    case "failed":
      return theme.bad;
  }
}

const cardStyle: React.CSSProperties = {
  background: theme.glass,
  border: `1px solid ${theme.borderSoft}`,
  borderRadius: theme.radius,
  padding: "0.7rem 0.9rem",
  backdropFilter: "blur(8px)",
};

const filterButton = (active: boolean): React.CSSProperties => ({
  padding: "0.2rem 0.6rem",
  borderRadius: 999,
  border: `1px solid ${active ? theme.accent : theme.border}`,
  background: active ? "rgba(47, 129, 247, 0.15)" : "transparent",
  color: active ? theme.text : theme.textDim,
  cursor: "pointer",
  fontSize: "0.72rem",
});

export function TaskHistory({ history }: { history: HistoryView[] }) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => selectHistory(history, filter), [history, filter]);

  const toggle = (orderId: string) =>
    setExpanded((prev) => ({ ...prev, [orderId]: !prev[orderId] }));

  return (
    <section>
      <h2 style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textFaint, margin: "0 0 0.5rem" }}>
        Task history · {rows.length}
      </h2>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
        {(["all", "completed", "cancelled", "failed"] as const).map((f) => (
          <button key={f} style={filterButton(filter === f)} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div style={cardStyle}>
          <span style={{ color: theme.textFaint, fontSize: "0.85rem" }}>No finished tasks yet</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          {rows.map((h) => (
            <div key={h.orderId} style={cardStyle}>
              <button
                onClick={() => toggle(h.orderId)}
                style={{
                  all: "unset",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  width: "100%",
                  cursor: "pointer",
                  fontSize: "0.82rem",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: outcomeColor(h.outcome),
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontFamily: theme.mono }}>{h.serial}</span>
                <span style={{ color: theme.textDim }}>{h.outcome}</span>
                <span style={{ marginLeft: "auto", color: theme.textFaint, fontSize: "0.75rem" }}>
                  {new Date(h.finishedAt).toLocaleTimeString()}
                </span>
              </button>
              {expanded[h.orderId] && (
                <div style={{ marginTop: "0.4rem", fontSize: "0.78rem", color: theme.textDim }}>
                  <div style={{ fontFamily: theme.mono, wordBreak: "break-all" }}>
                    {h.route.map((r) => r.nodeId).join(" → ") || "(no traversal reported)"}
                  </div>
                  {h.reason && <div style={{ color: theme.bad }}>reason: {h.reason}</div>}
                  <div style={{ color: theme.textFaint, fontSize: "0.72rem" }}>{h.orderId}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
