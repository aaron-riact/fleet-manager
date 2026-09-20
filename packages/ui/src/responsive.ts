import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/** Viewport breakpoint below which layouts stack and controls grow. */
export const NARROW_BREAKPOINT_PX = 900;

/** True when the viewport is at most the breakpoint. SSR/bun-safe: false without matchMedia. */
export function useNarrow(breakpointPx: number = NARROW_BREAKPOINT_PX): boolean {
  const query = `(max-width: ${breakpointPx}px)`;
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia !== "undefined" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

/** Desktop grid columns for the Shell content area. Pure, tested. */
export function shellColumns(narrow: boolean): string {
  return narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) 320px";
}

/**
 * Touch sizing spread onto interactive controls. Narrow viewports get
 * 44px minimum targets; desktop keeps the dense ops sizing. Pure, tested.
 */
export function touchStyle(narrow: boolean): CSSProperties {
  return narrow ? { minHeight: 44, fontSize: "0.9rem" } : {};
}
