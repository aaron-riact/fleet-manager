import type { Backend, LivePose, OrderView } from "@fleet-manager/ui";
import type { LockSnapshot, Site } from "@fleet-manager/core";

export interface MemoryBackend extends Backend {
  emitPose(pose: LivePose): void;
  emitLocks(snapshot: LockSnapshot): void;
  emitOrders(orders: OrderView[]): void;
}

/**
 * In-memory Backend twin for the serverless demo. Same interface the
 * ops UI consumes; fed by the in-page fleet instead of HTTP/SSE.
 */
export function createMemoryBackend(site: Site): MemoryBackend {
  const poseListeners = new Set<(pose: LivePose) => void>();
  const lockListeners = new Set<(snapshot: LockSnapshot) => void>();
  const orderListeners = new Set<(orders: OrderView[]) => void>();

  const subscribe = <T>(set: Set<(value: T) => void>, listener: (value: T) => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const emit =
    <T>(set: Set<(value: T) => void>) =>
    (value: T) => {
      for (const listener of [...set]) listener(value);
    };

  return {
    listSites: async () => [site.name],
    getMap: async () => site,
    watchPoses: (_site, onPose) => subscribe(poseListeners, onPose),
    watchLocks: (_site, onLocks) => subscribe(lockListeners, onLocks),
    watchOrders: (_site, onOrders) => subscribe(orderListeners, onOrders),
    emitPose: emit(poseListeners),
    emitLocks: emit(lockListeners),
    emitOrders: emit(orderListeners),
  };
}
