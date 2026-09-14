/**
 * Browser stub for the `debug` package (logging-only).
 *
 * debug's browser field points at a CJS file Vite's native ESM transform
 * cannot interop. Both graferse and vda-5050-lib use it for namespaced
 * logging only, so this preserves the call shape over console.debug.
 *
 * Namespaces are matched the way debug matches them: an exact name, a
 * trailing * for a prefix, and a leading - to exclude. Two shorthands stand
 * in for the noisy real prefixes.
 *
 *   ?debug=graferse        one line per robot move          (the default)
 *   ?debug=graferse*       plus the per-edge reservation tree
 *   ?debug=vda             vda-5050 clients and adapters
 *   ?debug=*,-vda-5050*    everything except the vda flood
 *
 * graferse renders its own nesting through console.group, so its lines do
 * not come through here — only `enabled` is read for those.
 */
const DEFAULT_NAMESPACES = "graferse";

/** Shorthands for prefixes that are tedious to type. */
const ALIASES: Record<string, string> = {
  vda: "vda-5050*",
};

function matches(pattern: string, namespace: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return namespace.startsWith(pattern.slice(0, -1));
  return namespace === pattern;
}

/** Build the namespace test for a debug spec, eg "graferse*,-vda-5050*". */
export function namespaceFilter(spec: string): (namespace: string) => boolean {
  const expand = (p: string) =>
    p.startsWith("-") ? `-${ALIASES[p.slice(1)] ?? p.slice(1)}` : ALIASES[p] ?? p;
  const patterns = spec.split(",").map((p) => p.trim()).filter(Boolean).map(expand);
  const skips = patterns.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
  const names = patterns.filter((p) => !p.startsWith("-"));
  return (namespace: string) => {
    if (skips.some((p) => matches(p, namespace))) return false;
    return names.some((p) => matches(p, namespace));
  };
}

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const enabled = namespaceFilter(params.get("debug") ?? DEFAULT_NAMESPACES);

export interface DebugFn {
  (...args: unknown[]): void;
  /** Read by callers that skip formatting work when logging is off. */
  enabled: boolean;
  extend(name: string): DebugFn;
}

function makeDebug(namespace: string): DebugFn {
  const fn = ((...args: unknown[]) => {
    if (fn.enabled) console.debug(`[${namespace}]`, ...args);
  }) as DebugFn;
  fn.enabled = enabled(namespace);
  fn.extend = (sub: string) => makeDebug(`${namespace}:${sub}`);
  return fn;
}

export default makeDebug;
