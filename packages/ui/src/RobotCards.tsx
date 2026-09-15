import React from "react";
import { robotStatus, statusColor, theme } from "./theme";
import type { RobotStatus } from "./theme";
import type { LivePose, OrderView } from "./backend";
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
          waitingOn,
        }),
        pose,
        order,
        waitingOn,
        holding: holdingBySerial.get(pose.serialNumber) ?? [],
      };
    });
}

const cardStyle: React.CSSProperties = {
  background: theme.glass,
  border: `1px solid ${theme.borderSoft}`,
  borderRadius: theme.radius,
  padding: "0.7rem 0.9rem",
  backdropFilter: "blur(8px)",
};

export function RobotCards({ cards }: { cards: RobotCardModel[] }) {
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
              {card.pose && Number.isFinite(card.pose.x)
                ? `${card.pose.x.toFixed(1)}, ${card.pose.y.toFixed(1)}`
                : "no fix"}
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
          </div>
        );
      })}
    </div>
  );
}
