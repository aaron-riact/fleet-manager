import { describe, expect, test } from "bun:test";
import { toastReducer } from "../src/Toast.js";

describe("toastReducer", () => {
  test("push appends, dismiss removes by id, clear empties", () => {
    const one = toastReducer([], { type: "push", toast: { id: 1, kind: "ok", message: "a" } });
    const two = toastReducer(one, { type: "push", toast: { id: 2, kind: "bad", message: "b" } });
    expect(two.map((t) => t.id)).toEqual([1, 2]);
    expect(toastReducer(two, { type: "dismiss", id: 1 }).map((t) => t.id)).toEqual([2]);
    expect(toastReducer(two, { type: "dismiss", id: 999 })).toHaveLength(2);
    expect(toastReducer(two, { type: "clear" })).toEqual([]);
  });

  test("the stack is bounded so a failure storm cannot bury the page", () => {
    let state = [{ id: 0, kind: "info", message: "old" }] as Parameters<typeof toastReducer>[0];
    for (let i = 1; i <= 10; i++) {
      state = toastReducer(state, { type: "push", toast: { id: i, kind: "bad", message: `${i}` } });
    }
    expect(state).toHaveLength(5);
    expect(state.map((t) => t.id)).toEqual([6, 7, 8, 9, 10]);
  });
});
