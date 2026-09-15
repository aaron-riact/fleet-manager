import React, { useEffect, useMemo, useState } from "react";
import { login } from "./authClient";
import { clearSession, loadSession, saveSession } from "./session";
import { createHttpBackend } from "./backend";
import type { Backend } from "./backend";
import { FleetMap } from "./FleetMap";
import type { LoginSession } from "./authClient";
import type { Site } from "@fleet-manager/core";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

const page: React.CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  background: "#0b0e14",
  color: "#e6edf3",
  fontFamily: "system-ui, sans-serif",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

const card: React.CSSProperties = {
  marginTop: "16vh",
  padding: "2rem",
  borderRadius: 12,
  background: "#11161f",
  border: "1px solid #232b38",
  minWidth: 320,
};

const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  margin: "0.5rem 0",
  padding: "0.6rem",
  borderRadius: 8,
  border: "1px solid #232b38",
  background: "#0b0e14",
  color: "inherit",
};

const button: React.CSSProperties = {
  width: "100%",
  marginTop: "0.75rem",
  padding: "0.6rem",
  borderRadius: 8,
  border: "none",
  background: "#2f81f7",
  color: "#fff",
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
    <form style={card} onSubmit={submit}>
      <h1 style={{ marginTop: 0 }}>Fleet Manager</h1>
      <input style={input} placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      <input style={input} placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      {error && <p style={{ color: "#f85149" }}>{error}</p>}
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sites = await backend.listSites();
        if (sites.length === 0) throw new Error("no sites assigned to this user");
        const map = await backend.getMap(sites[0]!);
        if (!cancelled) setSite(map);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load map");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend]);

  return (
    <div style={{ width: "100%", maxWidth: 960, padding: "1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Fleet Manager</strong>
        <span>
          {session.username} · {session.sites.join(", ")}{" "}
          <button
            style={{ ...button, width: "auto", marginTop: 0, padding: "0.4rem 0.8rem" }}
            onClick={onLogout}
          >
            Sign out
          </button>
        </span>
      </header>
      <main style={{ marginTop: "1rem" }}>
        {error && <p style={{ color: "#f85149" }}>{error}</p>}
        {!error && !site && <p style={{ color: "#8b949e" }}>Loading map…</p>}
        {site && (
          <>
            <h2 style={{ fontSize: "1rem", color: "#8b949e" }}>{site.name}</h2>
            <FleetMap site={site} />
          </>
        )}
        {extraPanel}
      </main>
    </div>
  );
}

export default function App({ createBackend }: { createBackend?: (session: LoginSession) => Backend } = {}) {
  const [session, setSession] = useState<LoginSession | null>(() => loadSession());
  const backend = useMemo(
    () =>
      session
        ? (createBackend?.(session) ?? createHttpBackend(API_BASE, session.token))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.token],
  );

  function handleLogin(next: LoginSession) {
    saveSession(next);
    setSession(next);
  }

  function handleLogout() {
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
      {session && backend ? (
        <Shell session={session} backend={backend} onLogout={handleLogout} />
      ) : (
        <LoginForm onLogin={handleLogin} />
      )}
    </div>
  );
}
