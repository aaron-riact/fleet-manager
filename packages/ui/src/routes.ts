import { useCallback, useEffect, useState } from "react";
import type { MobileTab } from "./MobileShell.js";

export interface Route {
  shell: "desktop" | "mobile";
  tab: MobileTab;
  /** Selected site; null means the stored/first site. Survives refresh. */
  site: string | null;
}

/**
 * Hash routes: `#/` (or anything unrecognized) is the desktop Shell,
 * `#/m/<tab>` is the mobile shell, with an optional `?site=<name>`
 * on either. Hash routing keeps this working from `file://` demos and
 * static hosts with no rewrite rules, and the route never reaches the
 * server. The legacy demo format `#/site=<name>` still parses.
 * Pure parse/format pair, tested.
 */
export function parseHash(hash: string): Route {
  const legacy = /^#\/site=([^/]+)\/?$/.exec(hash);
  if (legacy) return { shell: "desktop", tab: "map", site: decodeURIComponent(legacy[1]!) };
  const [path, query] = hash.split("?");
  const site = query
    ?.split("&")
    .map((part) => part.split("="))
    .find(([key]) => key === "site")?.[1];
  const decoded = site !== undefined && site !== "" ? decodeURIComponent(site) : null;
  const match = /^#\/m\/(map|tasks|robots|tools)\/?$/.exec(path ?? "");
  if (match) return { shell: "mobile", tab: match[1] as MobileTab, site: decoded };
  return { shell: "desktop", tab: "map", site: decoded };
}

export function hashFor(route: Route): string {
  const base = route.shell === "mobile" ? `#/m/${route.tab}` : "#/";
  return route.site ? `${base}?site=${encodeURIComponent(route.site)}` : base;
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
