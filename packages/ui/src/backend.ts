import { treaty } from "@elysiajs/eden";
import type { FleetApi } from "@fleet-manager/server";
import type { LockSnapshot, Site, TaskView, ZoneDemand } from "@fleet-manager/core";
import { errorMessage, fetchMap, fetchSites } from "./api.js";
import type { FetchFn } from "./api.js";

/** One reported action state; mirrors the AGV's actionStates generically. */
export interface LiveAction {
  actionId: string;
  actionType: string;
  actionStatus: string;
}

export interface LivePose {
  manufacturer: string;
  serialNumber: string;
  x: number;
  y: number;
  theta: number;
  driving: boolean;
  laden: boolean;
  charging: boolean;
  batteryCharge?: number;
  batteryVoltage?: number;
  /** False until the AGV trusts its own position — never treat as placed. */
  positionInitialized: boolean;
  eStop: boolean;
  fieldViolation: boolean;
  /** Live action states; absent on older backends means no actions. */
  actions?: LiveAction[];
}

export interface OrderView {
  orderId: string;
  serial: string;
  nodes: Array<{ nodeId: string; released: boolean }>;
  updateId: number;
}

/** Master-tracked link state per robot (ONLINE, OFFLINE, CONNECTIONBROKEN). */
export interface ConnectionView {
  manufacturer: string;
  serialNumber: string;
  state: string;
  timestamp: string;
}

/** One finished order, newest first. Mirrors the fleet's retained history. */
export interface HistoryView {
  orderId: string;
  serial: string;
  route: Array<{ nodeId: string; index: number }>;
  finishedAt: number;
  outcome: "completed" | "cancelled" | "failed";
  reason?: string;
}

export type Unsubscribe = () => void;

/**
 * Refuse fleet commands while offline. Reads get to attempt the network
 * (and fail through their normal error paths); mutations must never
 * leave the client when nobody can confirm them — queue-and-replay of
 * robot commands on reconnect is a footgun, not a feature.
 */
export function ensureOnline(): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("offline — reconnect to send commands");
  }
}
export type EventSourceFactory = (url: string) => {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  /** EventSource.CLOSED (2) once the browser has stopped retrying. */
  readyState?: number;
  close(): void;
};

/** EventSource.readyState once it will not reconnect by itself. */
const EVENT_SOURCE_CLOSED = 2;

/**
 * Called when a stream has stopped for good (the browser gives up after a
 * non-200 answer, such as a 401). Its data is frozen from then on.
 */
export type OnStreamLost = () => void;

export interface DispatchWaypoint {
  nodeId: string;
  x: number;
  y: number;
}

export interface DispatchInput {
  serialNumber: string;
  manufacturer?: string;
  waypoints: DispatchWaypoint[];
  /** Robot's live pose for the off-graph approach leg (demo + spawns). */
  from?: { x: number; y: number };
  /** Exact destination past the final node (station pose); skipped when on it. */
  exit?: { x: number; y: number };
  /**
   * Station (location id) the tour picks from / drops at. Hosts that own
   * domain work (demo trolleys) resolve these to entry waypoints; the
   * server ignores them and drives.
   */
  pickupStationId?: string;
  dropStationId?: string;
}

/**
 * Data source behind Shell. Prod talks HTTP/SSE to the server;
 * the demo injects an in-memory twin over its in-page fleet.
 */
export interface Backend {
  listSites(): Promise<string[]>;
  getMap(site: string): Promise<Site>;
  // Each watch* takes an optional onLost. Backends whose streams cannot
  // die (the demo's in-page twin) ignore it.
  watchPoses(site: string, onPose: (pose: LivePose) => void, onLost?: OnStreamLost): Unsubscribe;
  watchLocks(site: string, onLocks: (snap: LockSnapshot) => void, onLost?: OnStreamLost): Unsubscribe;
  watchOrders(site: string, onOrders: (orders: OrderView[]) => void, onLost?: OnStreamLost): Unsubscribe;
  watchHistory(site: string, onHistory: (history: HistoryView[]) => void, onLost?: OnStreamLost): Unsubscribe;
  watchConnections(site: string, onConns: (conns: ConnectionView[]) => void, onLost?: OnStreamLost): Unsubscribe;
  /** Send a tour. Resolves on accept; progress streams over watchOrders. */
  dispatchOrder(site: string, input: DispatchInput): Promise<void>;
  /** Park an idle robot (nearest free spot unless spotId given). */
  parkRobot(site: string, input: { serialNumber: string; spotId?: string }): Promise<{ spot: string }>;
  /** Park many robots at once; per-robot failures ride along, never abort. */
  parkRobots(
    site: string,
    input: { serialNumbers: string[]; zone?: string },
  ): Promise<{
    parked: Array<{ serialNumber: string; spot: string }>;
    failed: Array<{ serialNumber: string; error: string }>;
  }>;
  /** Cancel the active order. Rejects when the robot has none. */
  cancelOrder(site: string, input: { serialNumber: string }): Promise<void>;
  /** Queue a pickup→dropoff job for the assign pump. */
  submitTask(site: string, input: { pickup: string; dropoff: string }): Promise<{ taskId: string }>;
  /** Task queue snapshot (poll; transitions ride the orders stream). */
  listTasks(site: string): Promise<TaskView[]>;
  /** Withdraw a queued task. Rejects once it is assigned. */
  withdrawTask(site: string, taskId: string): Promise<void>;
  /** Queue a dropoff-only request; the pickup attaches later. */
  submitRequest(site: string, input: { dropoff: string; zone?: string }): Promise<{ taskId: string }>;
  /** Attach the pickup that makes a request dispatchable. */
  attachPickup(site: string, taskId: string, input: { pickup: string }): Promise<void>;
  /** Live zone demand counts. */
  watchDemands(site: string, onDemands: (demands: ZoneDemand[]) => void, onLost?: OnStreamLost): Unsubscribe;
  /** Signal unit demand for a zone (+n) or reset it (0). */
  bumpDemand(site: string, input: { zone: string; count: number }): Promise<{ zone: string; demand: number }>;
}

function watchStream<T>(
  baseUrl: string,
  token: string,
  site: string,
  stream: "poses" | "locks" | "orders" | "history" | "connections" | "demands",
  onEvent: (data: T) => void,
  openEventSource?: EventSourceFactory,
  onLost?: OnStreamLost,
): Unsubscribe {
  const open: EventSourceFactory =
    openEventSource ??
    ((url: string) => new EventSource(url) as unknown as ReturnType<EventSourceFactory>);
  const url = `${baseUrl}/api/sites/${encodeURIComponent(site)}/${stream}/stream?token=${encodeURIComponent(token)}`;
  const source = open(url);
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as T);
    } catch {
      /* malformed frame: skip */
    }
  };
  // EventSource reconnects on its own after a dropped connection.
  // Closing here would make one network blip permanent and freeze the
  // UI with stale data and no error. Only unsubscribe closes. A non-200
  // answer ends it for good, though: say so, or the UI shows frozen
  // data as live.
  source.onerror = () => {
    if (source.readyState === EVENT_SOURCE_CLOSED) onLost?.();
  };
  return () => source.close();
}

export function createHttpBackend(
  baseUrl: string,
  token: string,
  fetchFn: FetchFn = fetch,
  openEventSource?: EventSourceFactory,
): Backend {
  const treatyApi = (fetch: FetchFn) =>
    treaty<FleetApi>(baseUrl, {
      fetcher: fetch as typeof fetch,
      headers: { authorization: `Bearer ${token}` },
    });
  return {
    listSites: () => fetchSites(baseUrl, token, fetchFn),
    getMap: (site: string) => fetchMap(baseUrl, token, site, fetchFn),
    watchPoses: (site, onPose, onLost) =>
      watchStream(baseUrl, token, site, "poses", onPose, openEventSource, onLost),
    watchLocks: (site, onLocks, onLost) =>
      watchStream(baseUrl, token, site, "locks", onLocks, openEventSource, onLost),
    watchOrders: (site, onOrders, onLost) =>
      watchStream(baseUrl, token, site, "orders", onOrders, openEventSource, onLost),
    watchHistory: (site, onHistory, onLost) =>
      watchStream(baseUrl, token, site, "history", onHistory, openEventSource, onLost),
    watchConnections: (site, onConns, onLost) =>
      watchStream(baseUrl, token, site, "connections", onConns, openEventSource, onLost),
    dispatchOrder: async (site, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).orders.post({
        serialNumber: input.serialNumber,
        ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
        waypoints: input.waypoints,
        ...(input.exit ? { exit: input.exit } : {}),
      });
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
    },
    parkRobot: async (site, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).park.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
      return { spot: res.data.spot };
    },
    parkRobots: async (site, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site })["park-many"].post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
      return { parked: res.data.parked, failed: res.data.failed };
    },
    cancelOrder: async (site, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).orders.cancel.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
    },
    submitTask: async (site, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).tasks.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
      return { taskId: res.data.taskId };
    },
    listTasks: async (site) => {
      const res = await treatyApi(fetchFn).api.sites({ name: site }).tasks.get();
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
      return res.data.tasks as TaskView[];
    },
    submitRequest: async (site, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).tasks.request.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
      return { taskId: res.data.taskId };
    },
    attachPickup: async (site, taskId, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).tasks({ taskId }).pickup.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
    },
    watchDemands: (site, onDemands, onLost) =>
      watchStream(baseUrl, token, site, "demands", onDemands, openEventSource, onLost),
    bumpDemand: async (site, input) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).demand.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
      return { zone: res.data.zone, demand: res.data.demand };
    },
    withdrawTask: async (site, taskId) => {
      ensureOnline();
      const res = await treatyApi(fetchFn).api.sites({ name: site }).tasks({ taskId }).delete();
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
    },
  };
}
