import React, { useMemo, useState } from "react";
import { robotStatus, statusColor, theme } from "./theme";
import { useToast } from "./Toast";
import { useConfirm } from "./Confirm";
import type { RobotStatus } from "./theme";
import type { Backend, LivePose, OrderView } from "./backend";
import { DEFAULT_POSE_TTL_MS, isFresh } from "@fleet-manager/core";
import type { LockSnapshot } from "@fleet-manager/core";

export interface RobotCardModel {
  serialNumber: string;
  status: RobotStatus;
  pose?: LivePose;
  order?: OrderView;
  waitingOn?: string;
  holding: string[];
}

/** Join poses + orders + locks into one card per robot. Pure, tested. */
export function buildCards(
  poses: Record<string, LivePose>,
  orders: OrderView[],
  locks: LockSnapshot | undefined,
): RobotCardModel[] {
  const orderBySerial = new Map(orders.map((o) => [o.serial, o]));
  const holdingBySerial = new Map<string, string[]>();
  for (const node of locks?.nodeLocks ?? []) {
    for (const owner of node.owners) {
      const list = holdingBySerial.get(owner) ?? [];
      list.push(node.id);
      holdingBySerial.set(owner, list);
    }
  }
  return Object.values(poses)
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))
    .map((pose) => {
      const order = orderBySerial.get(pose.serialNumber);
      const waitingOn = order?.nodes.find((n) => !n.released)?.nodeId;
      return {
        serialNumber: pose.serialNumber,
        status: robotStatus({
          serialNumber: pose.serialNumber,
          x: pose.x,
          y: pose.y,
          driving: pose.driving,
          charging: pose.charging,
          positionInitialized: pose.positionInitialized,
          waitingOn,
        }),
        pose,
        order,
        waitingOn,
        holding: holdingBySerial.get(pose.serialNumber) ?? [],
      };
    });
}

export type FleetFilter = RobotStatus | "all";

/**
 * Poses older than this no longer describe where a robot is. Same
 * constant the server defaults to — a server run with a custom
 * poseTtlMs wants this raised to match.
 */
export const POSE_TTL_MS = DEFAULT_POSE_TTL_MS;

/**
 * Drop robots silent longer than ttlMs. A stale fix is not a position —
 * without this a dead robot cards as idle forever. Pure, tested.
 */
export function pruneStalePoses(
  poses: Record<string, LivePose>,
  seenAt: Record<string, number>,
  now: number,
  ttlMs: number = POSE_TTL_MS,
): Record<string, LivePose> {
  const fresh: Record<string, LivePose> = {};
  for (const [serial, pose] of Object.entries(poses)) {
    if (isFresh({ seenAt: seenAt[serial] ?? 0 }, now, ttlMs)) fresh[serial] = pose;
  }
  return fresh;
}

/** Per-status headcounts for the overview strip. Pure, tested. */
export function summarizeCards(cards: RobotCardModel[]): Record<RobotStatus, number> {
  const counts: Record<RobotStatus, number> = { driving: 0, waiting: 0, charging: 0, idle: 0, offline: 0 };
  for (const card of cards) counts[card.status] += 1;
  return counts;
}

/** Overview strip selection. Pure, tested. */
export function filterCards(cards: RobotCardModel[], filter: FleetFilter): RobotCardModel[] {
  return filter === "all" ? cards : cards.filter((c) => c.status === filter);
}

/** Status headcount chips; doubles as the fleet filter. Shared by desktop and mobile shells. */
export function StatusStrip({
  cards,
  value,
  onChange,
}: {
  cards: RobotCardModel[];
  value: FleetFilter;
  onChange: (filter: FleetFilter) => void;
}) {
  const summary = useMemo(() => summarizeCards(cards), [cards]);
  return (
    <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
      {(["all", "driving", "waiting", "charging", "idle", "offline"] as const).map((f) => {
        const active = value === f;
        const count = f === "all" ? cards.length : summary[f];
        return (
          <button
            key={f}
            onClick={() => onChange(f)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.2rem 0.6rem",
              borderRadius: 999,
              border: `1px solid ${active ? theme.accent : theme.border}`,
              background: active ? "rgba(47, 129, 247, 0.15)" : "transparent",
              color: active ? theme.text : theme.textDim,
              cursor: "pointer",
              fontSize: "0.72rem",
            }}
          >
            {f !== "all" && (
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: statusColor(f),
                }}
              />
            )}
            {f} · {count}
          </button>
        );
      })}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: theme.glass,
  border: `1px solid ${theme.borderSoft}`,
  borderRadius: theme.radius,
  padding: "0.7rem 0.9rem",
  backdropFilter: "blur(8px)",
};

const actionButton: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  borderRadius: 999,
  border: `1px solid ${theme.border}`,
  background: "transparent",
  color: theme.textDim,
  cursor: "pointer",
  fontSize: "0.72rem",
};

export function RobotCards({
  cards,
  backend,
  siteName,
}: {
  cards: RobotCardModel[];
  backend?: Backend;
  siteName?: string;
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const toast = useToast();
  const { confirm } = useConfirm();

  async function act(serialNumber: string, action: "park" | "cancel") {
    if (!backend || !siteName) return;
    const ok =
      action === "park"
        ? await confirm({
            title: `Park ${serialNumber}?`,
            body: "It drives off-graph and holds no locks.",
            confirmLabel: "Park robot",
          })
        : await confirm({
            title: `Cancel ${serialNumber}'s order?`,
            body: "The robot stops and its locks release.",
            confirmLabel: "Cancel order",
            danger: true,
          });
    if (!ok) return;
    setBusy((prev) => ({ ...prev, [serialNumber]: true }));
    try {
      if (action === "park") {
        const { spot } = await backend.parkRobot(siteName, { serialNumber });
        toast.show({ kind: "ok", message: `${serialNumber} parking at ${spot}` });
      } else {
        await backend.cancelOrder(siteName, { serialNumber });
        toast.show({ kind: "warn", message: `${serialNumber}'s order cancelled` });
      }
    } catch (e) {
      toast.show({ kind: "bad", message: e instanceof Error ? e.message : `${action} failed` });
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[serialNumber];
        return next;
      });
    }
  }

  if (cards.length === 0) {
    return (
      <div style={cardStyle}>
        <span style={{ color: theme.textFaint, fontSize: "0.85rem" }}>No robots reporting</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {cards.map((card) => {
        const done = card.order ? card.order.nodes.filter((n) => n.released).length : 0;
        const total = card.order ? card.order.nodes.length : 0;
        return (
          <div key={card.serialNumber} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: statusColor(card.status),
                  boxShadow: `0 0 8px ${statusColor(card.status)}`,
                  flexShrink: 0,
                }}
              />
              <code style={{ fontFamily: theme.mono, fontSize: "0.9rem" }}>{card.serialNumber}</code>
              <span style={{ marginLeft: "auto", color: theme.textDim, fontSize: "0.75rem" }}>
                {card.status}
                {card.waitingOn ? ` → ${card.waitingOn}` : ""}
              </span>
            </div>
            <div style={{ color: theme.textFaint, fontSize: "0.75rem", marginTop: "0.3rem" }}>
              {!card.pose || !Number.isFinite(card.pose.x)
                ? "no fix"
                : !card.pose.positionInitialized
                  ? "unlocalized"
                  : `${card.pose.x.toFixed(1)}, ${card.pose.y.toFixed(1)}`}
              {card.pose?.charging ? " · charging" : ""}
              {card.pose?.laden ? " · laden" : ""}
              {card.pose?.batteryCharge !== undefined ? ` · ${Math.round(card.pose.batteryCharge)}%` : ""}
              {card.pose?.eStop ? " · e-stop" : ""}
              {card.holding.length > 0 ? ` · holds ${card.holding.join(", ")}` : ""}
              {card.order ? ` · ${card.order.orderId} ${done}/${total}` : ""}
            </div>
            {card.order && total > 0 && (
              <div
                style={{
                  height: 3,
                  borderRadius: 2,
                  background: theme.borderSoft,
                  marginTop: "0.45rem",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(done / total) * 100}%`,
                    height: "100%",
                    background: theme.accent,
                    transition: "width 0.4s",
                  }}
                />
              </div>
            )}
            {backend && siteName && (
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}>
                <button
                  style={actionButton}
                  disabled={!!busy[card.serialNumber]}
                  onClick={() => void act(card.serialNumber, "park")}
                >
                  Park
                </button>
                {card.order && (
                  <button
                    style={actionButton}
                    disabled={!!busy[card.serialNumber]}
                    onClick={() => void act(card.serialNumber, "cancel")}
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
