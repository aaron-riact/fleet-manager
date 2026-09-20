import type { LiveAction } from "./backend.js";

/** Statuses that still gate the tour (nothing terminal yet). */
const ACTIVE = new Set(["INITIALIZING", "PAUSED", "RUNNING", "WAITING"]);

/**
 * The action currently holding the robot, if any: latest active state,
 * falling back to nothing once everything is terminal. Generic — the UI
 * never interprets actionTypes here; labels resolve separately.
 */
export function runningAction(actions: LiveAction[] | undefined): LiveAction | undefined {
  if (!actions) return undefined;
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i]!;
    if (ACTIVE.has(action.actionStatus)) return action;
  }
  return undefined;
}

/**
 * Default display label for an action type. Domain hosts inject their own
 * resolver (PICK/DROP, …); this fallback just humanizes camelCase so
 * unknown types stay readable instead of vanishing.
 */
export function defaultActionLabel(actionType: string): string {
  const words = actionType.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : actionType;
}
