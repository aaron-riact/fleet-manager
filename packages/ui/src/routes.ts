import { useCallback, useEffect, useState } from "react";
import type { MobileTab } from "./MobileShell.js";

export interface Route {
  shell: "desktop" | "mobile";
  tab: MobileTab;
}

/**
 * Hash routes: `#/` (or anything unrecognized) is the desktop Shell,
 * `#/m/<tab>` is the mobile shell. Hash routing keeps this working
 * from `file://` demos and static hosts with no rewrite rules, and the
 * route never reaches the server. Pure parse/format pair, tested.
 */
export function parseHash(hash: string): Route {
  const match = /^#\/m\/(map|tasks|robots|tools)\/?$/.exec(hash);
  if (match) return { shell: "mobile", tab: match[1] as MobileTab };
  return { shell: "desktop", tab: "map" };
}

export function hashFor(route: Route): string {
  return route.shell === "mobile" ? `#/m/${route.tab}` : "#/";
}

/** Current hash plus a navigator; re-renders on back/forward. */
export function useHashRoute(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: string) => {
    window.location.hash = next;
  }, []);
  return [hash, navigate];
}
