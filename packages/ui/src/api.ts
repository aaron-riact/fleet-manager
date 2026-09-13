import type { Site } from "@fleet-manager/core";

export type FetchFn = typeof fetch;

async function get<T>(baseUrl: string, path: string, token: string, fetchFn: FetchFn): Promise<T> {
  const res = await fetchFn(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const data = (await res.json()) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `request failed: ${res.status}`);
  return data as T;
}

export function fetchSites(baseUrl: string, token: string, fetchFn: FetchFn = fetch): Promise<string[]> {
  return get<{ sites: string[] }>(baseUrl, "/api/sites", token, fetchFn).then((d) => d.sites);
}

export function fetchMap(baseUrl: string, token: string, site: string, fetchFn: FetchFn = fetch): Promise<Site> {
  return get<Site>(baseUrl, `/api/sites/${encodeURIComponent(site)}/map`, token, fetchFn);
}
