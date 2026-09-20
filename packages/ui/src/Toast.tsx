import React, { createContext, useCallback, useContext, useMemo, useReducer, useRef } from "react";
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
