import React, { useMemo, useState } from "react";
import { theme } from "./theme";
import { ToastProvider, useFailedHistoryToasts } from "./Toast";
import { ConfirmProvider } from "./Confirm";
import { useFleetSite } from "./useFleetSite";
import { OfflineBanner } from "./online";
import { FleetMap } from "./FleetMap";
import { OrderComposer } from "./OrderComposer";
import { RobotCards, StatusStrip, buildCards, filterCards } from "./RobotCards";
import type { FleetFilter } from "./RobotCards";
import { TaskHistory } from "./TaskHistory";
import { TaskBoard } from "./TaskBoard";
import type { Backend } from "./backend";
import type { LoginSession } from "./authClient";

export type MobileTab = "map" | "tasks" | "robots" | "tools";

export interface MobileShellProps {
  session: LoginSession;
  backend: Backend;
  onLogout: () => void;
  extraPanel?: React.ReactNode;
  tab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const page: React.CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  backgroundColor: theme.bg,
  color: theme.text,
  fontFamily: theme.font,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

const glass: React.CSSProperties = {
  background: theme.glass,
  border: `1px solid ${theme.borderSoft}`,
  borderRadius: theme.radius,
  backdropFilter: "blur(10px)",
};

function MobileView({ session, backend, onLogout, extraPanel, tab, onTabChange }: MobileShellProps) {
  const { site, error, poses, locks, orders, history, live } = useFleetSite(backend);
  useFailedHistoryToasts(history);
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>("all");

  const cards = useMemo(() => buildCards(poses, orders, locks), [poses, orders, locks]);
  const visibleCards = useMemo(() => filterCards(cards, fleetFilter), [cards, fleetFilter]);

  const tabs: MobileTab[] = extraPanel ? ["map", "tasks", "robots", "tools"] : ["map", "tasks", "robots"];
  const counts: Record<MobileTab, number | undefined> = {
    map: undefined,
    tasks: undefined,
    robots: cards.length,
    tools: undefined,
  };

  return (
    <div style={{ ...page, paddingBottom: "4.5rem" }}>
      <OfflineBanner />
      <header
        style={{
          ...glass,
          width: "100%",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.6rem 1rem",
          position: "sticky",
          top: 0,
          zIndex: 10,
          borderRadius: 0,
          borderLeft: "none",
          borderRight: "none",
          borderTop: "none",
        }}
      >
        <span style={{ fontSize: "1.1rem", color: theme.accent }}>⬢</span>
        <strong style={{ fontSize: "0.95rem" }}>Fleet</strong>
        {site && (
          <span style={{ fontSize: "0.7rem", color: theme.textDim, border: `1px solid ${theme.border}`, borderRadius: 999, padding: "0.1rem 0.6rem" }}>
            {site.name}
          </span>
        )}
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: live ? theme.ok : theme.warn }} />
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ color: theme.textDim, fontSize: "0.75rem" }}>{session.username}</span>
          <a href="#/" style={{ color: theme.textDim, fontSize: "0.75rem", textDecoration: "none" }}>
            Desktop
          </a>
          <button
            style={{ border: `1px solid ${theme.border}`, background: "transparent", color: theme.text, borderRadius: 999, padding: "0.3rem 0.8rem", fontSize: "0.75rem", cursor: "pointer" }}
            onClick={onLogout}
          >
            Out
          </button>
        </span>
      </header>
      <main style={{ width: "100%", boxSizing: "border-box", padding: "0.75rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {error && <p style={{ ...glass, padding: "0.8rem 1rem", color: theme.bad }}>{error}</p>}
        {!error && !site && <p style={{ color: theme.textDim }}>Loading map…</p>}
        {site && tab === "map" && (
          <div style={{ ...glass, padding: "0.6rem" }}>
            <FleetMap
              site={site}
              locks={locks}
              parking={site.parking ?? []}
              waits={orders.flatMap((o) => {
                const next = o.nodes.find((n) => !n.released);
                return next ? [{ serialNumber: o.serial, nodeId: next.nodeId }] : [];
              })}
              robots={Object.values(poses).map((p) => ({
                serialNumber: p.serialNumber,
                x: p.x,
                y: p.y,
                theta: p.theta,
                laden: p.laden,
              }))}
            />
            {(site.locations ?? []).length > 0 && (
              <div style={{ marginTop: "0.75rem" }}>
                <OrderComposer site={site} siteName={site.name} backend={backend} poses={poses} />
              </div>
            )}
          </div>
        )}
        {site && tab === "tasks" && (
          <>
            <TaskBoard siteName={site.name} backend={backend} nodes={site.nodes} />
            <TaskHistory history={history} />
          </>
        )}
        {site && tab === "robots" && (
          <section>
            <h2 style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textFaint, margin: "0 0 0.5rem" }}>
              Robots · {fleetFilter === "all" ? cards.length : `${visibleCards.length} of ${cards.length}`}
            </h2>
            <StatusStrip cards={cards} value={fleetFilter} onChange={setFleetFilter} />
            <RobotCards cards={visibleCards} backend={backend} siteName={site.name} />
          </section>
        )}
        {site && tab === "tools" && extraPanel}
      </main>
      <nav
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          display: "flex",
          background: "rgba(13, 20, 32, 0.95)",
          borderTop: `1px solid ${theme.borderSoft}`,
          backdropFilter: "blur(10px)",
          zIndex: 10,
        }}
      >
        {tabs.map((t) => {
          const active = tab === t;
          const count = counts[t];
          return (
            <button
              key={t}
              onClick={() => onTabChange(t)}
              style={{
                flex: 1,
                padding: "0.8rem 0 calc(0.8rem + env(safe-area-inset-bottom))",
                border: "none",
                background: "transparent",
                color: active ? theme.accent : theme.textDim,
                fontWeight: active ? 700 : 400,
                fontSize: "0.8rem",
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {t}
              {count !== undefined && count > 0 ? ` · ${count}` : ""}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Tabbed handheld shell: same Backend seam, same components as the
 * desktop Shell, composed for narrow screens. Desktop stays the default;
 * routing (next commit) switches between the two.
 */
export function MobileShell(props: MobileShellProps) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <MobileView {...props} />
      </ConfirmProvider>
    </ToastProvider>
  );
}
