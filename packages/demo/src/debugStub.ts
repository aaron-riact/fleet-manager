/**
 * Browser stub for the `debug` package (logging-only).
 *
 * debug's browser field points at a CJS file Vite's native ESM transform
 * cannot interop. Both graferse and vda-5050-lib use it for namespaced
 * logging only, so this preserves the call shape over console.debug.
 */
export interface DebugFn {
  (...args: unknown[]): void;
  extend(name: string): DebugFn;
}

function makeDebug(namespace: string): DebugFn {
  const fn = ((...args: unknown[]) => {
    console.debug(`[${namespace}]`, ...args);
  }) as DebugFn;
  fn.extend = (sub: string) => makeDebug(`${namespace}:${sub}`);
  return fn;
}

export default makeDebug;
