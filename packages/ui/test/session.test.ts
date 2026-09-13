import { describe, expect, test } from "bun:test";
import { clearSession, loadSession, saveSession } from "../src/session.js";
import type { KeyValueStore } from "../src/session.js";

const memStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

describe("session store", () => {
  test("save/load/clear roundtrip", () => {
    const store = memStore();
    expect(loadSession(store)).toBeNull();
    saveSession({ token: "t", username: "u", sites: ["s"] }, store);
    expect(loadSession(store)).toEqual({ token: "t", username: "u", sites: ["s"] });
    clearSession(store);
    expect(loadSession(store)).toBeNull();
  });

  test("corrupt or partial data loads as null", () => {
    const store = memStore();
    store.setItem("fleet-manager.session", "{nope");
    expect(loadSession(store)).toBeNull();
    store.setItem("fleet-manager.session", JSON.stringify({ username: "u" }));
    expect(loadSession(store)).toBeNull();
  });
});
