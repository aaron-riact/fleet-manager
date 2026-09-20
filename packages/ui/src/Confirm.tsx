import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { theme } from "./theme";

export interface ConfirmRequest {
  title: string;
  body?: string;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Red confirm button for irreversible actions. */
  danger?: boolean;
}

const ConfirmContext = createContext<{ confirm: (req: ConfirmRequest) => Promise<boolean> }>({
  confirm: async () => false,
});

/**
 * Modal confirmation for destructive actions. `confirm()` resolves true
 * only on the explicit confirm button — backdrop click, Cancel, and
 * unmount all resolve false, so a lost dialog can never arm an action.
 * Pure JSX wiring (no DOM tests per repo rules); the promise lifecycle
 * is deliberately trivially shaped so there is nothing else to unit-test.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(
    null,
  );

  const confirm = useCallback(
    (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...req, resolve });
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    setPending((prev) => {
      // Resolving a promise twice is a no-op, so StrictMode's
      // double-invoked updater cannot double-arm the action.
      prev?.resolve(ok);
      return null;
    });
  }, []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(3, 6, 12, 0.6)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 60,
            padding: "1rem",
          }}
          onClick={() => settle(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title}
            style={{
              background: theme.bgRaised,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius,
              padding: "1.2rem 1.4rem",
              maxWidth: "22rem",
              width: "100%",
              boxShadow: "0 24px 80px rgba(0, 0, 0, 0.5)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 0.4rem", fontSize: "1rem" }}>{pending.title}</h3>
            {pending.body && (
              <p style={{ margin: "0 0 1rem", color: theme.textDim, fontSize: "0.85rem" }}>{pending.body}</p>
            )}
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => settle(false)}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: 8,
                  border: `1px solid ${theme.border}`,
                  background: "transparent",
                  color: theme.text,
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => settle(true)}
                autoFocus
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: 8,
                  border: "none",
                  background: pending.danger ? theme.bad : `linear-gradient(180deg, #3f8cff, ${theme.accent})`,
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                {pending.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): { confirm: (req: ConfirmRequest) => Promise<boolean> } {
  return useContext(ConfirmContext);
}
