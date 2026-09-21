import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { theme } from "./theme";

export type ToastKind = "ok" | "warn" | "bad" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export type ToastAction =
  | { type: "push"; toast: Toast }
  | { type: "dismiss"; id: number }
  | { type: "clear" };

/** Toast stack as a pure reducer (tested); ids are assigned by the provider. */
export function toastReducer(state: Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case "push":
      return [...state.slice(-4), action.toast];
    case "dismiss":
      return state.filter((t) => t.id !== action.id);
    case "clear":
      return [];
  }
}

const ToastContext = createContext<{ show: (toast: Omit<Toast, "id">, timeoutMs?: number) => void }>({
  show: () => {},
});

const kindColor: Record<ToastKind, string> = {
  ok: theme.ok,
  warn: theme.warn,
  bad: theme.bad,
  info: theme.accent,
};

/** Global toasts: mutation outcomes and background failures operators would otherwise miss. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const nextId = useRef(1);
  const timeouts = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timeouts.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timeouts.current.delete(id);
    }
    dispatch({ type: "dismiss", id });
  }, []);

  const show = useCallback(
    (toast: Omit<Toast, "id">, timeoutMs = 5000) => {
      const id = nextId.current++;
      dispatch({ type: "push", toast: { ...toast, id } });
      if (timeoutMs > 0) {
        timeouts.current.set(
          id,
          setTimeout(() => dismiss(id), timeoutMs),
        );
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          right: "1rem",
          bottom: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          zIndex: 50,
          maxWidth: "min(22rem, calc(100vw - 2rem))",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: theme.glass,
              border: `1px solid ${theme.borderSoft}`,
              borderLeft: `3px solid ${kindColor[t.kind]}`,
              borderRadius: theme.radius,
              backdropFilter: "blur(10px)",
              padding: "0.6rem 0.9rem",
              fontSize: "0.82rem",
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.45)",
              cursor: "pointer",
            }}
            onClick={() => dismiss(t.id)}
            title="Dismiss"
          >
            <span style={{ flex: 1 }}>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): { show: (toast: Omit<Toast, "id">, timeoutMs?: number) => void } {
  return useContext(ToastContext);
}

export interface FailedHistoryEntry {
  orderId: string;
  serial: string;
  outcome: string;
  reason?: string;
}

/** What the hook carries between snapshots. */
export interface FailureToastState {
  /** Order ids already accounted for, toasted or baselined away. */
  known: Set<string>;
  /** The baseline snapshot has been taken for the current site. */
  baselined: boolean;
}

export function emptyFailureToastState(): FailureToastState {
  return { known: new Set(), baselined: false };
}

/**
 * Fold one history snapshot in, returning the entries to toast. The
 * baseline snapshot toasts nothing — those failures predate the session
 * — and an empty baseline is still a baseline. Counting ids cannot tell
 * the two apart: on a fresh server the baseline is empty, so nothing is
 * ever recorded and the session's first real failure reads as the
 * baseline in turn. `received` is the stream saying it has answered;
 * false resets, which is what a site switch needs.
 */
export function foldFailureToasts(
  state: FailureToastState,
  history: FailedHistoryEntry[],
  received: boolean,
): { state: FailureToastState; toast: FailedHistoryEntry[] } {
  if (!received) return { state: emptyFailureToastState(), toast: [] };
  const known = new Set(state.known);
  if (!state.baselined) {
    for (const h of history) known.add(h.orderId);
    return { state: { known, baselined: true }, toast: [] };
  }
  const toast: FailedHistoryEntry[] = [];
  for (const h of history) {
    if (known.has(h.orderId)) continue;
    if (h.outcome === "failed") toast.push(h);
    known.add(h.orderId);
  }
  // Retention drops old entries from the stream; drop them here too, or
  // the set grows for the life of the tab.
  if (known.size > history.length + 50) {
    const live = new Set(history.map((h) => h.orderId));
    for (const id of known) if (!live.has(id)) known.delete(id);
  }
  return { state: { known, baselined: true }, toast };
}

/**
 * Toast tours that die outside any open form. The history stream is the
 * only witness, so every shell mounts this.
 */
export function useFailedHistoryToasts(
  history: FailedHistoryEntry[],
  received: boolean,
): void {
  const toast = useToast();
  const state = useRef(emptyFailureToastState());
  useEffect(() => {
    const next = foldFailureToasts(state.current, history, received);
    state.current = next.state;
    for (const h of next.toast) {
      toast.show({
        kind: "bad",
        message: `Tour for ${h.serial} failed${h.reason ? `: ${h.reason}` : ""}`,
      });
    }
  }, [history, received, toast]);
}
