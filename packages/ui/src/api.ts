import { treaty } from "@elysiajs/eden";
import type { FleetApi } from "@fleet-manager/server";
import type { Site } from "@fleet-manager/core";

export type FetchFn = typeof fetch;

function api(baseUrl: string, fetchFn: FetchFn) {
  return treaty<FleetApi>(baseUrl, { fetcher: fetchFn as typeof fetch });
}

async function unwrap<T>(promise: Promise<{
  data: unknown;
  error: unknown;
  status: number;
}>): Promise<T> {
  const res = await promise;
  const data = res.data as (T & { error?: unknown }) | null;
  if (data != null && typeof data.error === "string") throw new Error(data.error);
  if (res.error != null || res.status >= 400 || data == null) {
    throw new Error(errorMessage(res.error, res.status));
  }
  return data;
}

export function errorMessage(error: unknown, status: number): string {
  const value = (error as { value?: unknown } | null)?.value ?? error;
  return typeof value === "object" && value !== null && "error" in value &&
      typeof (value as { error: unknown }).error === "string"
    ? (value as { error: string }).error
    : `request failed: ${status}`;
}

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

export function fetchSites(baseUrl: string, token: string, fetchFn: FetchFn = fetch): Promise<string[]> {
  return unwrap<{ sites: string[] }>(
    api(baseUrl, fetchFn).api.sites.get({ headers: authHeaders(token) }),
  ).then((d) => d.sites);
}

export function fetchMap(baseUrl: string, token: string, site: string, fetchFn: FetchFn = fetch): Promise<Site> {
  return unwrap(
    api(baseUrl, fetchFn).api.sites({ name: site }).map.get({ headers: authHeaders(token) }),
  ) as Promise<Site>;
}
