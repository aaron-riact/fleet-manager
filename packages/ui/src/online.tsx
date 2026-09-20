import React, { useEffect, useState } from "react";
import { theme } from "./theme";

/** Browser online state; true outside browsers (SSR, tests). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

/**
 * Offline bar for both shells. Streams stall and the guard below
 * refuses commands while offline, so without this the app would sit
 * on frozen data looking alive.
 */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="alert"
      style={{
        background: theme.warn,
        color: "#111",
        fontSize: "0.8rem",
        fontWeight: 600,
        textAlign: "center",
        padding: "0.45rem 1rem",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      Offline — showing last known snapshots. Commands are disabled until you reconnect.
    </div>
  );
}
