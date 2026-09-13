import type { LoginSession } from "./authClient.js";

const KEY = "fleet-manager.session";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

function defaultStore(): KeyValueStore {
  if (typeof localStorage !== "undefined") return localStorage;
  return memoryStore();
}

/** Persisted login session (localStorage in browsers). Store is injectable for tests. */
export function loadSession(store: KeyValueStore = defaultStore()): LoginSession | null {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LoginSession>;
    if (typeof parsed.token !== "string" || typeof parsed.username !== "string") return null;
    return { token: parsed.token, username: parsed.username, sites: Array.isArray(parsed.sites) ? parsed.sites : [] };
  } catch {
    return null;
  }
}

export function saveSession(session: LoginSession, store: KeyValueStore = defaultStore()): void {
  store.setItem(KEY, JSON.stringify(session));
}

export function clearSession(store: KeyValueStore = defaultStore()): void {
  store.removeItem(KEY);
}
