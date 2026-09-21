import React, { useMemo, useState } from "react";
import { login } from "./authClient";
import { clearSession, loadSession, saveSession } from "./session";
import { createHttpBackend } from "./backend";
import type { Backend } from "./backend";
import { FleetMap } from "./FleetMap";
import type { MapMarker } from "./FleetMap";
import { defaultActionLabel, runningAction } from "./actions";
import { OrderComposer } from "./OrderComposer";
import { RobotCards, StatusStrip, buildCards, filterCards } from "./RobotCards";
import type { FleetFilter } from "./RobotCards";
import { TaskHistory } from "./TaskHistory";
import { TaskBoard } from "./TaskBoard";
import { DemandBoard } from "./DemandBoard";
import { ToastProvider, useFailedHistoryToasts, useToast } from "./Toast";
import { ConfirmProvider, useConfirm } from "./Confirm";
import { useFleetSite } from "./useFleetSite";
import { OfflineBanner } from "./online";
import { shellColumns } from "./responsive";
import { useNarrow } from "./responsive";
import { MobileShell } from "./MobileShell";
import { hashFor, parseHash, useHashRoute } from "./routes";
import { theme } from "./theme";
import type { LoginSession } from "./authClient";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

const page: React.CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  background: `radial-gradient(1200px 600px at 70% -10%, #12233d 0%, ${theme.bg} 55%)`,
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

const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  margin: "0.5rem 0",
  padding: "0.65rem 0.8rem",
  borderRadius: 10,
  border: `1px solid ${theme.border}`,
  background: theme.bg,
  color: "inherit",
  fontSize: "0.95rem",
};

const button: React.CSSProperties = {
  width: "100%",
  marginTop: "0.75rem",
  padding: "0.65rem",
  borderRadius: 10,
  border: "none",
  background: `linear-gradient(180deg, #3f8cff, ${theme.accent})`,
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

function LoginForm({ onLogin }: { onLogin: (s: LoginSession) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(API_BASE, username, password));
    } catch (e) {
      setError(e instanceof Error ? e.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      style={{
        ...glass,
        marginTop: "14vh",
        padding: "2.2rem",
        minWidth: 340,
        boxShadow: "0 24px 80px rgba(47, 129, 247, 0.18)",
      }}
      onSubmit={submit}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <span style={{ fontSize: "1.6rem", color: theme.accent }}>⬢</span>
        <h1 style={{ margin: 0, fontSize: "1.35rem", letterSpacing: "-0.01em" }}>Fleet Manager</h1>
      </div>
      <p style={{ color: theme.textDim, fontSize: "0.85rem", margin: "0.5rem 0 1rem" }}>
        Secure sign-in for fleet operators
      </p>
      <input style={input} placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      <input style={input} placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      {error && <p style={{ color: theme.bad }}>{error}</p>}
      <button style={button} type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export interface ShellProps {
  session: LoginSession;
  backend: Backend;
  onLogout: () => void;
  extraPanel?: React.ReactNode;
  /** Pinned initial site (deep links); the stored selection wins afterwards. */
  initialSite?: string | null;
  /** Called alongside the internal switch so hosts can persist it (hash). */
  onSiteChange?: (site: string) => void;
  /** Host-owned map annotations (trolleys, pallets); drawn, never interpreted. */
  markers?: MapMarker[];
  /**
   * Domain display names for action types. Injected by the host — the
   * shells only ever render the returned string.
   */
  resolveActionLabel?: (actionType: string) => string;
}

export function Shell(props: ShellProps) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <ShellView {...props} />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function ShellView({
  session,
  backend,
  onLogout,
  extraPanel,
  initialSite,
  onSiteChange,
  markers,
  resolveActionLabel = defaultActionLabel,
}: ShellProps) {
  const toast = useToast();
  const { site, sites, siteName, setSiteName, error, poses, locks, orders, history, historyReceived, live } =
    useFleetSite(backend, initialSite);
  const changeSite = (name: string) => {
    setSiteName(name);
    onSiteChange?.(name);
  };
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>("all");

  useFailedHistoryToasts(history, historyReceived);

  const cards = useMemo(() => buildCards(poses, orders, locks), [poses, orders, locks]);
  const visibleCards = useMemo(() => filterCards(cards, fleetFilter), [cards, fleetFilter]);
  const narrow = useNarrow();
  const { confirm } = useConfirm();

  async function parkAll() {
    if (cards.length === 0) return;
    const withOrders = cards.filter((c) => c.order).length;
    const ok = await confirm({
      title: `Park ${cards.length === 1 ? "robot" : "all " + cards.length + " robots"}?`,
      body:
        withOrders > 0
          ? `${withOrders} with active orders will abandon their tours.`
          : "Idle robots drive off-graph and hold no locks.",
      confirmLabel: "Park all",
      danger: withOrders > 0,
    });
    if (!ok || !site) return;
    try {
      const { parked, failed } = await backend.parkRobots(
        site.name,
        { serialNumbers: cards.map((c) => c.serialNumber) },
      );
      if (failed.length === 0) {
        toast.show({ kind: "ok", message: `${parked.length} robot${parked.length === 1 ? "" : "s"} parking` });
      } else {
        toast.show({
          kind: "warn",
          message: `${parked.length} parking, ${failed.length} failed (${failed.map((f) => f.serialNumber).join(", ")})`,
        });
      }
    } catch (e) {
      toast.show({ kind: "bad", message: e instanceof Error ? e.message : "park all failed" });
    }
  }

  return (
    <div style={{ width: "100%", maxWidth: 1280, padding: "1rem 1.25rem 2rem" }}>
      <OfflineBanner />
      <header
        style={{
          ...glass,
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.6rem 1rem",
          position: "sticky",
          top: "0.75rem",
          zIndex: 10,
        }}
      >
        <span style={{ fontSize: "1.2rem", color: theme.accent }}>⬢</span>
        <strong style={{ letterSpacing: "-0.01em" }}>Fleet Manager</strong>
        {site &&
          (sites.length > 1 ? (
            <select
              aria-label="Site"
              value={siteName ?? site.name}
              onChange={(e) => changeSite(e.target.value)}
              style={{
                fontSize: "0.75rem",
                color: theme.text,
                border: `1px solid ${theme.border}`,
                borderRadius: 999,
                padding: "0.15rem 0.5rem",
                background: theme.bg,
                cursor: "pointer",
              }}
            >
              {sites.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <span
              style={{
                fontSize: "0.75rem",
                color: theme.textDim,
                border: `1px solid ${theme.border}`,
                borderRadius: 999,
                padding: "0.15rem 0.7rem",
              }}
            >
              {site.name}
            </span>
          ))}
        <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.75rem", color: theme.textDim }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: live ? theme.ok : theme.warn,
              boxShadow: live ? `0 0 8px ${theme.ok}` : "none",
            }}
          />
          {live ? "live" : "connecting…"}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ color: theme.textDim, fontSize: "0.85rem" }}>{session.username}</span>
          <a
            href={hashFor({ shell: "mobile", tab: "map", site: siteName ?? null })}
            style={{ color: theme.textDim, fontSize: "0.8rem", textDecoration: "none" }}
          >
            Mobile
          </a>
          <button
            style={{
              width: "auto",
              marginTop: 0,
              padding: "0.4rem 0.9rem",
              borderRadius: 999,
              border: `1px solid ${theme.border}`,
              background: "transparent",
              color: theme.text,
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
            onClick={onLogout}
          >
            Sign out
          </button>
        </span>
      </header>
      <main style={{ marginTop: "1rem" }}>
        {error && (
          <p style={{ ...glass, padding: "0.8rem 1rem", color: theme.bad }}>
            {error}
          </p>
        )}
        {!error && !site && <p style={{ color: theme.textDim }}>Loading map…</p>}
        {site && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: shellColumns(narrow),
              gap: "1rem",
              alignItems: "start",
            }}
          >
            <div style={{ ...glass, padding: "0.75rem" }}>
              <FleetMap
                site={site}
                locks={locks}
                parking={site.parking ?? []}
                waits={orders.flatMap((o) => {
                  const next = o.nodes.find((n) => !n.released);
                  return next ? [{ serialNumber: o.serial, nodeId: next.nodeId }] : [];
                })}
                markers={markers}
                robots={Object.values(poses).map((p) => {
                  const action = runningAction(p.actions);
                  return {
                    serialNumber: p.serialNumber,
                    x: p.x,
                    y: p.y,
                    theta: p.theta,
                    laden: p.laden,
                    ...(action ? { actionLabel: resolveActionLabel(action.actionType) } : {}),
                  };
                })}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {(site.locations ?? []).length > 0 && (
                <OrderComposer site={site} siteName={site.name} backend={backend} poses={poses} />
              )}
              <section>
                <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", margin: "0 0 0.5rem" }}>
                  <h2 style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textFaint, margin: 0 }}>
                    Robots · {fleetFilter === "all" ? cards.length : `${visibleCards.length} of ${cards.length}`}
                  </h2>
                  {cards.length > 0 && (
                    <button
                      onClick={() => void parkAll()}
                      style={{
                        marginLeft: "auto",
                        padding: "0.2rem 0.6rem",
                        borderRadius: 999,
                        border: `1px solid ${theme.border}`,
                        background: "transparent",
                        color: theme.textDim,
                        cursor: "pointer",
                        fontSize: "0.72rem",
                      }}
                    >
                      Park all
                    </button>
                  )}
                </div>
                <StatusStrip cards={cards} value={fleetFilter} onChange={setFleetFilter} />
                <RobotCards
                  cards={visibleCards}
                  backend={backend}
                  siteName={site?.name}
                  resolveActionLabel={resolveActionLabel}
                />
              </section>
              <TaskHistory history={history} />
              {(site.locations ?? []).length > 0 && (
                <DemandBoard
                  siteName={site.name}
                  backend={backend}
                  locations={site.locations ?? []}
                  nodes={site.nodes}
                />
              )}
              <TaskBoard siteName={site.name} backend={backend} nodes={site.nodes} />
            </div>
          </div>
        )}
        {extraPanel}
      </main>
    </div>
  );
}

export default function App({
  createBackend,
  sessionOverride,
  extraPanel,
  initialSite,
  markers,
  resolveActionLabel,
}: {
  createBackend?: (session: LoginSession) => Backend;
  /** Demo bypass: skip the login form entirely. */
  sessionOverride?: LoginSession | null;
  extraPanel?: React.ReactNode;
  /** Pinned initial site (deep links); the stored selection wins afterwards. */
  initialSite?: string | null;
  markers?: MapMarker[];
  resolveActionLabel?: (actionType: string) => string;
} = {}) {
  const [session, setSession] = useState<LoginSession | null>(() => loadSession());
  const effective = sessionOverride ?? session;
  const backend = useMemo(
    () =>
      effective
        ? (createBackend?.(effective) ?? createHttpBackend(API_BASE, effective.token))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effective?.token],
  );

  function handleLogin(next: LoginSession) {
    saveSession(next);
    setSession(next);
  }

  function handleLogout() {
    if (sessionOverride) return;
    if (session) {
      fetch(`${API_BASE}/api/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
      }).catch(() => {});
    }
    clearSession();
    setSession(null);
  }

  const [hash, navigate] = useHashRoute();
  const route = parseHash(hash);
  // The tools tab only exists where an extra panel is mounted (demo).
  const tab = route.tab === "tools" && !extraPanel ? "map" : route.tab;
  // Explicit prop (demo boot) wins; otherwise the hash carries the site
  // so refresh preserves it, falling back to stored/first inside the hook.
  const effectiveSite = initialSite ?? route.site;
  const changeSite = (name: string) =>
    navigate(
      route.shell === "mobile"
        ? hashFor({ shell: "mobile", tab, site: name })
        : hashFor({ shell: "desktop", tab: "map", site: name }),
    );

  return (
    <div style={page}>
      {effective && backend ? (
        route.shell === "mobile" ? (
          <MobileShell
            session={effective}
            backend={backend}
            onLogout={handleLogout}
            extraPanel={extraPanel}
            tab={tab}
            onTabChange={(t) =>
              navigate(hashFor({ shell: "mobile", tab: t, site: route.site }))
            }
            initialSite={effectiveSite}
            onSiteChange={changeSite}
            markers={markers}
            resolveActionLabel={resolveActionLabel}
          />
        ) : (
          <Shell
            session={effective}
            backend={backend}
            onLogout={handleLogout}
            extraPanel={extraPanel}
            initialSite={effectiveSite}
            onSiteChange={changeSite}
            markers={markers}
            resolveActionLabel={resolveActionLabel}
          />
        )
      ) : (
        <LoginForm onLogin={handleLogin} />
      )}
    </div>
  );
}
