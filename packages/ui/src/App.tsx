import React, { useEffect, useMemo, useRef, useState } from "react";
import { login } from "./authClient";
import { clearSession, loadSession, saveSession } from "./session";
import { createHttpBackend } from "./backend";
import type { Backend, HistoryView, LivePose, OrderView } from "./backend";
import type { LockSnapshot } from "@fleet-manager/core";
import { FleetMap } from "./FleetMap";
import { OrderComposer } from "./OrderComposer";
import { POSE_TTL_MS, RobotCards, buildCards, filterCards, pruneStalePoses, summarizeCards } from "./RobotCards";
import type { FleetFilter } from "./RobotCards";
import { TaskHistory } from "./TaskHistory";
import { TaskBoard } from "./TaskBoard";
import { statusColor, theme } from "./theme";
import type { LoginSession } from "./authClient";
import type { Site } from "@fleet-manager/core";

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

export function Shell({
  session,
  backend,
  onLogout,
  extraPanel,
}: {
  session: LoginSession;
  backend: Backend;
  onLogout: () => void;
  extraPanel?: React.ReactNode;
}) {
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poses, setPoses] = useState<Record<string, LivePose>>({});
  const [locks, setLocks] = useState<LockSnapshot | undefined>(undefined);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [history, setHistory] = useState<HistoryView[]>([]);
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>("all");
  const seenAt = useRef<Record<string, number>>({});

  // Sweep silent robots off the cards. The poses stream only pushes on
  // arrival, so without this a robot that stops reporting cards as placed
  // forever — including through a total-silence outage the server cannot
  // prune its way out of either.
  useEffect(() => {
    const sweep = setInterval(() => {
      const at = seenAt.current;
      setPoses((prev) => {
        const next = pruneStalePoses(prev, at, Date.now(), POSE_TTL_MS);
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 5_000);
    return () => clearInterval(sweep);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    (async () => {
      try {
        const sites = await backend.listSites();
        if (sites.length === 0) throw new Error("no sites assigned to this user");
        const name = sites[0]!;
        const map = await backend.getMap(name);
        if (cancelled) return;
        setSite(map);
        cleanups.push(
          backend.watchPoses(name, (pose) => {
            if (cancelled) return;
            seenAt.current[pose.serialNumber] = Date.now();
            setPoses((prev) => ({ ...prev, [pose.serialNumber]: pose }));
          }),
          backend.watchLocks(name, (snap) => {
            if (!cancelled) setLocks(snap);
          }),
          backend.watchOrders(name, (list) => {
            if (!cancelled) setOrders(list);
          }),
          backend.watchHistory(name, (list) => {
            if (!cancelled) setHistory(list);
          }),
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load map");
      }
    })();
    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [backend]);

  const cards = useMemo(() => buildCards(poses, orders, locks), [poses, orders, locks]);
  const summary = useMemo(() => summarizeCards(cards), [cards]);
  const visibleCards = useMemo(() => filterCards(cards, fleetFilter), [cards, fleetFilter]);
  const live = site !== null && error === null;

  return (
    <div style={{ width: "100%", maxWidth: 1280, padding: "1rem 1.25rem 2rem" }}>
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
        {site && (
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
        )}
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
              gridTemplateColumns: "minmax(0, 1fr) 320px",
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
                robots={Object.values(poses).map((p) => ({
                  serialNumber: p.serialNumber,
                  x: p.x,
                  y: p.y,
                  theta: p.theta,
                  laden: p.laden,
                }))}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {(site.locations ?? []).length > 0 && (
                <OrderComposer site={site} siteName={site.name} backend={backend} poses={poses} />
              )}
              <section>
                <h2 style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: theme.textFaint, margin: "0 0 0.5rem" }}>
                  Robots · {fleetFilter === "all" ? cards.length : `${visibleCards.length} of ${cards.length}`}
                </h2>
                <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
                  {(["all", "driving", "waiting", "charging", "idle", "offline"] as const).map((f) => {
                    const active = fleetFilter === f;
                    const count = f === "all" ? cards.length : summary[f];
                    return (
                      <button
                        key={f}
                        onClick={() => setFleetFilter(f)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.35rem",
                          padding: "0.2rem 0.6rem",
                          borderRadius: 999,
                          border: `1px solid ${active ? theme.accent : theme.border}`,
                          background: active ? "rgba(47, 129, 247, 0.15)" : "transparent",
                          color: active ? theme.text : theme.textDim,
                          cursor: "pointer",
                          fontSize: "0.72rem",
                        }}
                      >
                        {f !== "all" && (
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: statusColor(f),
                            }}
                          />
                        )}
                        {f} · {count}
                      </button>
                    );
                  })}
                </div>
                <RobotCards cards={visibleCards} backend={backend} siteName={site?.name} />
              </section>
              <TaskHistory history={history} />
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
}: {
  createBackend?: (session: LoginSession) => Backend;
  /** Demo bypass: skip the login form entirely. */
  sessionOverride?: LoginSession | null;
  extraPanel?: React.ReactNode;
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

  return (
    <div style={page}>
      {effective && backend ? (
        <Shell session={effective} backend={backend} onLogout={handleLogout} extraPanel={extraPanel} />
      ) : (
        <LoginForm onLogin={handleLogin} />
      )}
    </div>
  );
}
