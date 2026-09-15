import type { Site } from "@fleet-manager/core";
import { fetchMap, fetchSites } from "./api.js";
import type { FetchFn } from "./api.js";

/**
 * Data source behind Shell. Prod talks HTTP to the server;
 * the demo injects an in-memory twin. Only fetching here —
 * live subscriptions (poses/locks/orders) come next.
 */
export interface Backend {
  listSites(): Promise<string[]>;
  getMap(site: string): Promise<Site>;
}

export function createHttpBackend(
  baseUrl: string,
  token: string,
  fetchFn: FetchFn = fetch,
): Backend {
  return {
    listSites: () => fetchSites(baseUrl, token, fetchFn),
    getMap: (site: string) => fetchMap(baseUrl, token, site, fetchFn),
  };
}
