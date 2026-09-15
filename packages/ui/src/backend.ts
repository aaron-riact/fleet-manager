import type { LockSnapshot, Site } from "@fleet-manager/core";
import { fetchMap, fetchSites } from "./api.js";
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
  return {
    listSites: () => fetchSites(baseUrl, token, fetchFn),
    getMap: (site: string) => fetchMap(baseUrl, token, site, fetchFn),
    watchPoses: (site, onPose) => watchStream(baseUrl, token, site, "poses", onPose, openEventSource),
    watchLocks: (site, onLocks) => watchStream(baseUrl, token, site, "locks", onLocks, openEventSource),
    watchOrders: (site, onOrders) => watchStream(baseUrl, token, site, "orders", onOrders, openEventSource),
  };
}
