import type { LockSnapshot } from "@fleet-manager/core";

export type LockEvent =
  | { type: "locked"; node: string; by: string }
  | { type: "released"; node: string; by: string }
  | { type: "waiting"; node: string; by: string }
  | { type: "unwaited"; node: string; by: string };

/** Human-readable lock transitions between two snapshots (event feed UI). */
export function diffLocks(prev: LockSnapshot | undefined, next: LockSnapshot): LockEvent[] {
  const events: LockEvent[] = [];
  if (!prev) return events;
  const before = new Map(prev.nodeLocks.map((n) => [n.id, n]));
  for (const node of next.nodeLocks) {
    const was = before.get(node.id);
    for (const owner of node.owners) {
      if (!was?.owners.includes(owner)) events.push({ type: "locked", node: node.id, by: owner });
    }
    for (const owner of was?.owners ?? []) {
      if (!node.owners.includes(owner)) events.push({ type: "released", node: node.id, by: owner });
    }
    for (const waiter of node.waiters) {
      if (!was?.waiters.includes(waiter)) events.push({ type: "waiting", node: node.id, by: waiter });
    }
    for (const waiter of was?.waiters ?? []) {
      if (!node.waiters.includes(waiter)) events.push({ type: "unwaited", node: node.id, by: waiter });
    }
  }
  return events;
}

export function formatLockEvent(e: LockEvent): string {
  switch (e.type) {
    case "locked":
      return `${e.by} holds ${e.node}`;
    case "released":
      return `${e.by} freed ${e.node}`;
    case "waiting":
      return `${e.by} waits on ${e.node}`;
    case "unwaited":
      return `${e.by} stops waiting on ${e.node}`;
  }
}
