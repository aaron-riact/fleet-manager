import { describe, expect, test } from "bun:test";
import { emptyFailureToastState, foldFailureToasts, toastReducer } from "../src/Toast.js";
import type { FailedHistoryEntry } from "../src/Toast.js";

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

const entry = (orderId: string, outcome = "failed"): FailedHistoryEntry => ({
  orderId,
  serial: "r1",
  outcome,
  reason: "blocked",
});

describe("foldFailureToasts", () => {
  test("nothing is toasted until the stream has answered", () => {
    const first = foldFailureToasts(emptyFailureToastState(), [], false);
    expect(first.toast).toEqual([]);
    expect(first.state.baselined).toBe(false);
  });

  test("the baseline snapshot is silent but remembered", () => {
    const after = foldFailureToasts(emptyFailureToastState(), [entry("o1"), entry("o2")], true);
    expect(after.toast).toEqual([]);
    expect(after.state.baselined).toBe(true);
    expect(foldFailureToasts(after.state, [entry("o1"), entry("o2")], true).toast).toEqual([]);
  });

  test("an empty baseline is still a baseline, so the first real failure toasts", () => {
    // A fresh server: nothing in history, so nothing gets recorded. The
    // next frame is the session's first genuine failure, not a baseline.
    const base = foldFailureToasts(emptyFailureToastState(), [], true);
    expect(base.state.baselined).toBe(true);
    const next = foldFailureToasts(base.state, [entry("o1")], true);
    expect(next.toast.map((h) => h.orderId)).toEqual(["o1"]);
  });

  test("only failures toast, and only once", () => {
    const base = foldFailureToasts(emptyFailureToastState(), [], true);
    const next = foldFailureToasts(base.state, [entry("o1", "completed"), entry("o2")], true);
    expect(next.toast.map((h) => h.orderId)).toEqual(["o2"]);
    expect(foldFailureToasts(next.state, [entry("o1", "completed"), entry("o2")], true).toast).toEqual([]);
  });

  test("a site switch re-baselines instead of toasting the new site's history", () => {
    const base = foldFailureToasts(emptyFailureToastState(), [], true);
    const reset = foldFailureToasts(base.state, [], false);
    expect(reset.state.baselined).toBe(false);
    expect(foldFailureToasts(reset.state, [entry("o9")], true).toast).toEqual([]);
  });

  test("ids of dropped entries do not accumulate for the life of the tab", () => {
    let state = foldFailureToasts(emptyFailureToastState(), [], true).state;
    for (let i = 0; i < 80; i++) {
      state = foldFailureToasts(state, [entry(`o${i}`)], true).state;
    }
    expect(state.known.size).toBeLessThanOrEqual(51);
  });
});
