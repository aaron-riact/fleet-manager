import { useEffect, useRef, useState } from "react";
import type { LockSnapshot, Site } from "@fleet-manager/core";
import { POSE_TTL_MS, pruneStalePoses } from "./RobotCards";
import type { Backend, HistoryView, LivePose, OrderView } from "./backend";

export interface FleetSiteData {
  site: Site | null;
  /** Sites this login may view; the selector hides itself for single-site users. */
  sites: string[];
  siteName: string | null;
  setSiteName: (name: string) => void;
  error: string | null;
  poses: Record<string, LivePose>;
  locks: LockSnapshot | undefined;
  orders: OrderView[];
  history: HistoryView[];
  live: boolean;
}

const SITE_STORAGE_KEY = "fleet.site";

/**
 * Pick the preferred site when assigned, else the first. Pure, tested —
 * a stale stored name (user lost access, site renamed) falls back
 * instead of stranding the UI on an error.
 */
export function resolveSiteName(sites: string[], preferred: string | null): string | null {
  if (sites.length === 0) return null;
  if (preferred && sites.includes(preferred)) return preferred;
  return sites[0]!;
}

function storedSiteName(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(SITE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Subscribe one backend site: map, poses, locks, orders, history, plus
 * the staleness sweep. Extracted from Shell so desktop and mobile shells
 * share one subscription implementation instead of copying six effects.
 * The selected site persists across reloads per browser, unless the
 * caller pins an initial site (deep links) that takes precedence once.
 */
export function useFleetSite(backend: Backend, initialSite?: string | null): FleetSiteData {
  const [site, setSite] = useState<Site | null>(null);
  const [sites, setSites] = useState<string[]>([]);
  const [wanted, setWanted] = useState<string | null>(() => initialSite ?? storedSiteName());
  const [error, setError] = useState<string | null>(null);
  const [poses, setPoses] = useState<Record<string, LivePose>>({});
  const [locks, setLocks] = useState<LockSnapshot | undefined>(undefined);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [history, setHistory] = useState<HistoryView[]>([]);
  const seenAt = useRef<Record<string, number>>({});
  const siteName = resolveSiteName(sites, wanted);

  const setSiteName = (name: string) => {
    setWanted(name);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(SITE_STORAGE_KEY, name);
    } catch {
      /* private mode: selection simply does not persist */
    }
  };

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
        const available = await backend.listSites();
        if (cancelled) return;
        setSites(available);
        const name = resolveSiteName(available, wanted);
        if (!name) throw new Error("no sites assigned to this user");
        // Clear per-site state up front: the previous site's robots must
        // never flash through while the new map loads.
        setError(null);
        setSite(null);
        setPoses({});
        setLocks(undefined);
        setOrders([]);
        setHistory([]);
        seenAt.current = {};
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
  }, [backend, wanted]);

  return { site, sites, siteName, setSiteName, error, poses, locks, orders, history, live: site !== null && error === null };
}
