import { useEffect, useRef, useState } from "react";
import type { LockSnapshot, Site } from "@fleet-manager/core";
import { POSE_TTL_MS, pruneStalePoses } from "./RobotCards";
import type { Backend, HistoryView, LivePose, OrderView } from "./backend";

export interface FleetSiteData {
  site: Site | null;
  error: string | null;
  poses: Record<string, LivePose>;
  locks: LockSnapshot | undefined;
  orders: OrderView[];
  history: HistoryView[];
  live: boolean;
}

/**
 * Subscribe one backend site: map, poses, locks, orders, history, plus
 * the staleness sweep. Extracted from Shell so desktop and mobile shells
 * share one subscription implementation instead of copying six effects.
 */
export function useFleetSite(backend: Backend): FleetSiteData {
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poses, setPoses] = useState<Record<string, LivePose>>({});
  const [locks, setLocks] = useState<LockSnapshot | undefined>(undefined);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [history, setHistory] = useState<HistoryView[]>([]);
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

  return { site, error, poses, locks, orders, history, live: site !== null && error === null };
}
