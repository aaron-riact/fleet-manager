/**
 * Browser stub for the `debug` package (logging-only).
 *
 * debug's browser field points at a CJS file Vite's native ESM transform
 * cannot interop. Both graferse and vda-5050-lib use it for namespaced
 * logging only, so this preserves the call shape over console.debug.
 *
 * Only the graferse namespace passes by default — vda-5050-lib logs every
 * state publish and floods idle consoles. Widen via ?debug=... :
 *   ?debug=*            everything
 *   ?debug=vda          vda-5050 clients and adapters
 *   ?debug=graferse,vda both (default is graferse only)
 */
const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const want = (params.get("debug") ?? "graferse").split(",");

function enabled(namespace: string): boolean {
  if (want.includes("*")) return true;
  if (namespace === "graferse" || namespace.startsWith("graferse:")) return want.includes("graferse");
  return want.includes("vda");
}

export interface DebugFn {
  (...args: unknown[]): void;
  extend(name: string): DebugFn;
}

function makeDebug(namespace: string): DebugFn {
  const on = enabled(namespace);
  const fn = ((...args: unknown[]) => {
    if (on) console.debug(`[${namespace}]`, ...args);
  }) as DebugFn;
  fn.extend = (sub: string) => makeDebug(`${namespace}:${sub}`);
  return fn;
}

export default makeDebug;
