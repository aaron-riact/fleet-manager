import React, { useState } from "react";
import { login } from "./authClient";
import { clearSession, loadSession, saveSession } from "./session";
import type { LoginSession } from "./authClient";

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

function Shell({ session, onLogout }: { session: LoginSession; onLogout: () => void }) {
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
      <main style={{ ...card, marginTop: "2rem" }}>
        <h2 style={{ marginTop: 0 }}>Map &amp; robots</h2>
        <p style={{ color: "#8b949e" }}>Coming next: live fleet map with nodes, edges, and locks.</p>
      </main>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<LoginSession | null>(() => loadSession());

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
      {session ? <Shell session={session} onLogout={handleLogout} /> : <LoginForm onLogin={handleLogin} />}
    </div>
  );
}
