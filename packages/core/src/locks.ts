import { Graferse } from "graferse";
import type { NextNode } from "graferse";
import type { Site } from "./site.js";

export interface NodeLockState {
  id: string;
  owners: string[];
  waiters: string[];
}

export interface EdgeLockState {
  fromId: string;
  toId: string;
  owners: string[];
  held: boolean;
}

export interface LockSnapshot {
  nodeLocks: NodeLockState[];
  edgeLocks: EdgeLockState[];
}

export interface PathLocker {
  arrivedAt(index: number): void;
  clearAllPathLocks(): void;
}

export interface AgentLocker {
  makePathLocker(path: string[], onAllowed: (next: NextNode[], remaining: number) => void): PathLocker;
  clearAllLocks(): void;
}

export interface FleetLocks {
  lockerFor(agent: string): AgentLocker;
  snapshot(): LockSnapshot;
}

const linkKey = (a: string, b: string) => `${a}→${b}`;

/**
 * Traffic locks for a site, backed by graferse.
 * One Lock per node, one LinkLock per link (shared both directions).
 * Agents lock current+next as they arrive; snapshot() feeds the overlay/API.
 */
export function buildLocks(site: Site): FleetLocks {
  const creator = new Graferse<string>((x) => x);
  const nodeLocks = new Map<string, ReturnType<Graferse<string>["makeLock"]>>();
  for (const node of site.nodes) nodeLocks.set(node.id, creator.makeLock(node.id));

  const linkLocks = new Map<string, ReturnType<Graferse<string>["makeLinkLock"]>>();
  const linkIndex = new Map<string, { fromId: string; toId: string }>();
  for (const link of site.links) {
    const lock = creator.makeLinkLock(link.source, link.destination, link.bidirectional ?? false);
    linkLocks.set(linkKey(link.source, link.destination), lock);
    linkLocks.set(linkKey(link.destination, link.source), lock);
    linkIndex.set(linkKey(link.source, link.destination), { fromId: link.source, toId: link.destination });
  }

  const getLock = (id: string) => {
    const lock = nodeLocks.get(id);
    if (!lock) throw new Error(`no lock for node "${id}"`);
    return lock;
  };
  const getLockForLink = (from: string, to: string) => {
    const lock = linkLocks.get(linkKey(from, to));
    if (!lock) throw new Error(`no link lock from "${from}" to "${to}"`);
    return lock;
  };

  const makeLocker = creator.makeMakeLocker(getLock, getLockForLink);

  return {
    lockerFor: (agent: string) => {
      const locker = makeLocker(agent);
      return {
        makePathLocker: (path, onAllowed) => locker.makePathLocker(path)(onAllowed),
        clearAllLocks: () => locker.clearAllLocks(),
      };
    },
    snapshot: () => ({
      nodeLocks: [...nodeLocks].map(([id, lock]) => ({
        id,
        owners: [...lock.lockedBy].sort(),
        waiters: [...lock.waiting].sort(),
      })),
      edgeLocks: [...linkIndex].map(([, { fromId, toId }]) => {
        const details = linkLocks.get(linkKey(fromId, toId))!.getDetails();
        const owners = [
          ...new Set([...(details.lockers.get(fromId) ?? []), ...(details.lockers.get(toId) ?? [])]),
        ].sort();
        return { fromId, toId, owners, held: owners.length > 0 };
      }),
    }),
  };
}
