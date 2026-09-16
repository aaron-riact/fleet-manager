import { treaty } from "@elysiajs/eden";
import type { FleetApi } from "@fleet-manager/server";
import type { LockSnapshot, Site } from "@fleet-manager/core";
import { errorMessage, fetchMap, fetchSites } from "./api.js";
import type { FetchFn } from "./api.js";

export interface LivePose {
  manufacturer: string;
  serialNumber: string;
  x: number;
  y: number;
  theta: number;
  driving: boolean;
}

export interface OrderView {
  orderId: string;
  serial: string;
  nodes: Array<{ nodeId: string; released: boolean }>;
  updateId: number;
}

export type Unsubscribe = () => void;
export type EventSourceFactory = (url: string) => {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
};

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
}

/**
 * Data source behind Shell. Prod talks HTTP/SSE to the server;
 * the demo injects an in-memory twin over its in-page fleet.
 */
export interface Backend {
  listSites(): Promise<string[]>;
  getMap(site: string): Promise<Site>;
  watchPoses(site: string, onPose: (pose: LivePose) => void): Unsubscribe;
  watchLocks(site: string, onLocks: (snap: LockSnapshot) => void): Unsubscribe;
  watchOrders(site: string, onOrders: (orders: OrderView[]) => void): Unsubscribe;
  /** Send a tour. Resolves on accept; progress streams over watchOrders. */
  dispatchOrder(site: string, input: DispatchInput): Promise<void>;
  /** Park an idle robot (nearest free spot unless spotId given). */
  parkRobot(site: string, input: { serialNumber: string; spotId?: string }): Promise<{ spot: string }>;
  /** Cancel the active order. Rejects when the robot has none. */
  cancelOrder(site: string, input: { serialNumber: string }): Promise<void>;
}

function watchStream<T>(
  baseUrl: string,
  token: string,
  site: string,
  stream: "poses" | "locks" | "orders",
  onEvent: (data: T) => void,
  openEventSource?: EventSourceFactory,
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
  // UI with stale data and no error. Only unsubscribe closes.
  source.onerror = () => {};
  return () => source.close();
}

export function createHttpBackend(
  baseUrl: string,
  token: string,
  fetchFn: FetchFn = fetch,
  openEventSource?: EventSourceFactory,
): Backend {
  const treatyApi = (fetch: FetchFn) => treaty<FleetApi>(baseUrl, { fetcher: fetch as typeof fetch });
  return {
    listSites: () => fetchSites(baseUrl, token, fetchFn),
    getMap: (site: string) => fetchMap(baseUrl, token, site, fetchFn),
    watchPoses: (site, onPose) => watchStream(baseUrl, token, site, "poses", onPose, openEventSource),
    watchLocks: (site, onLocks) => watchStream(baseUrl, token, site, "locks", onLocks, openEventSource),
    watchOrders: (site, onOrders) => watchStream(baseUrl, token, site, "orders", onOrders, openEventSource),
    dispatchOrder: async (site, input) => {
      const res = await treatyApi(fetchFn).api.sites({ name: site }).orders.post({
        serialNumber: input.serialNumber,
        ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
        waypoints: input.waypoints,
      });
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
    },
    parkRobot: async (site, input) => {
      const res = await treatyApi(fetchFn).api.sites({ name: site }).park.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
      return { spot: res.data.spot };
    },
    cancelOrder: async (site, input) => {
      const res = await treatyApi(fetchFn).api.sites({ name: site }).orders.cancel.post(input);
      if (res.data == null || "error" in res.data) {
        throw new Error(
          res.data != null ? res.data.error : errorMessage(res.error, res.status),
        );
      }
    },
  };
}
