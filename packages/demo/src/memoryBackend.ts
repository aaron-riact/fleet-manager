import type {
  Backend,
  ConnectionView,
  DispatchInput,
  HistoryView,
  LivePose,
  OrderView,
} from "@fleet-manager/ui";
import type { TaskView, ZoneDemand } from "@fleet-manager/core";
import type { DemandCounts, LockSnapshot, Site } from "@fleet-manager/core";

export interface MemoryBackend extends Backend {
  emitPose(pose: LivePose): void;
  emitLocks(snapshot: LockSnapshot): void;
  emitOrders(orders: OrderView[]): void;
  emitHistory(history: HistoryView[]): void;
  emitConnections(conns: ConnectionView[]): void;
  emitDemands(demands: ZoneDemand[]): void;
}

export interface MemoryBackendActions {
  dispatchOrder?(site: string, input: DispatchInput): Promise<void>;
  parkRobot?(site: string, input: { serialNumber: string; spotId?: string }): Promise<{ spot: string }>;
  cancelOrder?(site: string, input: { serialNumber: string }): Promise<void>;
  submitTask?(site: string, input: { pickup: string; dropoff: string }): Promise<{ taskId: string }>;
  listTasks?(site: string): Promise<TaskView[]>;
  withdrawTask?(site: string, taskId: string): Promise<void>;
  parkRobots?(
    site: string,
    input: { serialNumbers: string[]; zone?: string },
  ): Promise<{
    parked: Array<{ serialNumber: string; spot: string }>;
    failed: Array<{ serialNumber: string; error: string }>;
  }>;
  submitRequest?(site: string, input: { dropoff: string; zone?: string }): Promise<{ taskId: string }>;
  attachPickup?(site: string, taskId: string, input: { pickup: string }): Promise<void>;
  bumpDemand?(site: string, input: { zone: string; count: number }): Promise<{ zone: string; demand: number }>;
}

/**
 * In-memory Backend twin for the serverless demo. Same interface the
 * ops UI consumes; fed by the in-page fleet instead of HTTP/SSE.
 */
export function createMemoryBackend(site: Site, actions: MemoryBackendActions = {}): MemoryBackend {
  const poseListeners = new Set<(pose: LivePose) => void>();
  const lockListeners = new Set<(snapshot: LockSnapshot) => void>();
  const orderListeners = new Set<(orders: OrderView[]) => void>();
  const historyListeners = new Set<(history: HistoryView[]) => void>();
  const connListeners = new Set<(conns: ConnectionView[]) => void>();
  const demandListeners = new Set<(demands: ZoneDemand[]) => void>();

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
    watchHistory: (_site, onHistory) => subscribe(historyListeners, onHistory),
    watchConnections: (_site, onConns) => subscribe(connListeners, onConns),
    watchDemands: (_site, onDemands) => subscribe(demandListeners, onDemands),
    dispatchOrder: async (site, input) => {
      if (!actions.dispatchOrder) throw new Error(`no dispatcher for site "${site}"`);
      await actions.dispatchOrder(site, input);
    },
    parkRobot: async (site, input) => {
      if (!actions.parkRobot) throw new Error(`no dispatcher for site "${site}"`);
      return actions.parkRobot(site, input);
    },
    cancelOrder: async (site, input) => {
      if (!actions.cancelOrder) throw new Error(`no dispatcher for site "${site}"`);
      await actions.cancelOrder(site, input);
    },
    submitTask: async (site, input) => {
      if (!actions.submitTask) throw new Error(`no dispatcher for site "${site}"`);
      return actions.submitTask(site, input);
    },
    listTasks: async (site) => {
      if (!actions.listTasks) throw new Error(`no dispatcher for site "${site}"`);
      return actions.listTasks(site);
    },
    withdrawTask: async (site, taskId) => {
      if (!actions.withdrawTask) throw new Error(`no dispatcher for site "${site}"`);
      await actions.withdrawTask(site, taskId);
    },
    parkRobots: async (site, input) => {
      if (!actions.parkRobots) throw new Error(`no dispatcher for site "${site}"`);
      return actions.parkRobots(site, input);
    },
    submitRequest: async (site, input) => {
      if (!actions.submitRequest) throw new Error(`no dispatcher for site "${site}"`);
      return actions.submitRequest(site, input);
    },
    attachPickup: async (site, taskId, input) => {
      if (!actions.attachPickup) throw new Error(`no dispatcher for site "${site}"`);
      await actions.attachPickup(site, taskId, input);
    },
    bumpDemand: async (site, input) => {
      if (!actions.bumpDemand) throw new Error(`no dispatcher for site "${site}"`);
      return actions.bumpDemand(site, input);
    },
    emitPose: emit(poseListeners),
    emitLocks: emit(lockListeners),
    emitOrders: emit(orderListeners),
    emitHistory: emit(historyListeners),
    emitConnections: emit(connListeners),
    emitDemands: emit(demandListeners),
  };
}
