import { Topic } from "vda-5050-lib";
import type { MasterController } from "vda-5050-lib";

export interface RobotPose {
  manufacturer: string;
  serialNumber: string;
  x: number;
  y: number;
  theta: number;
  driving: boolean;
  /** True while the AGV reports charging in progress. */
  charging: boolean;
  /** State of charge in percent, when the AGV reports one. */
  batteryCharge?: number;
  batteryVoltage?: number;
  /** False until the AGV trusts its own position — never treat as placed. */
  positionInitialized: boolean;
  /** Any active e-stop (AUTOACK, MANUAL, or REMOTE — never the NONE value). */
  eStop: boolean;
  fieldViolation: boolean;
  /** True while the AGV reports any load on board (generic laden flag). */
  laden: boolean;
  /**
   * Live action states, newest report wins. Generic pass-through — the
   * watcher never interprets actionTypes; labels resolve in the UI.
   */
  actions: RobotAction[];
}

/** One reported action state (order or instant scope). */
export interface RobotAction {
  actionId: string;
  actionType: string;
  /** VDA status name, e.g. INITIALIZING, RUNNING, FINISHED, FAILED. */
  actionStatus: string;
}

interface TopicAccess {
  subscribeTopic(
    topic: Topic,
    subject: { manufacturer?: string; serialNumber?: string },
    handler: (object: {
      manufacturer?: string;
      serialNumber?: string;
      agvPosition?: { x?: number; y?: number; theta?: number; positionInitialized?: boolean };
      driving?: boolean;
      batteryState?: { charging?: boolean; batteryCharge?: number; batteryVoltage?: number };
      safetyState?: { eStop?: string; fieldViolation?: boolean };
      loads?: unknown[];
      actionStates?: Array<{ actionId?: unknown; actionType?: unknown; actionStatus?: unknown }>;
    }) => void,
  ): Promise<string>;
}

export interface RobotConnection {
  manufacturer: string;
  serialNumber: string;
  /** VDA connection state: ONLINE, OFFLINE, or CONNECTIONBROKEN. */
  state: string;
  timestamp: string;
}

interface ConnectionTracker {
  trackAgvs(
    handler: (
      subject: { manufacturer?: string; serialNumber?: string },
      state: string,
      timestamp: string,
    ) => void,
  ): void;
}

/**
 * Lifecycle connection states for every AGV the master tracks. Known
 * states replay synchronously on subscribe (baseline); changes push.
 * The lib chains track handlers permanently, so unsubscribe only stops
 * delivery — subscribe once per master, not per stream.
 */
export function watchConnections(
  master: MasterController,
  onConnection: (conn: RobotConnection) => void,
): () => void {
  const tracker = master as unknown as ConnectionTracker;
  let stopped = false;
  tracker.trackAgvs((subject, state, timestamp) => {
    if (stopped || typeof subject.serialNumber !== "string") return;
    onConnection({
      manufacturer: subject.manufacturer ?? "unknown",
      serialNumber: subject.serialNumber,
      state,
      timestamp,
    });
  });
  return () => {
    stopped = true;
  };
}

export interface RawState {
  manufacturer: string;
  serialNumber: string;
  /** Untouched topic body, for operators that need the full VehicleState. */
  body: unknown;
}

/**
 * Raw state traffic, unprojected. The poses watcher above derives the
 * driving view; this keeps the whole body for on-demand inspection
 * (debug, acceptance against real AGVs). One entry per robot, latest
 * wins — callers bound retention themselves.
 */
export async function watchStates(
  master: MasterController,
  manufacturer: string | undefined,
  onState: (state: RawState) => void,
): Promise<() => void> {
  const access = master as unknown as TopicAccess;
  const subject = manufacturer === undefined ? {} : { manufacturer };
  const id = await access.subscribeTopic(Topic.State, subject, (object) => {
    if (typeof object.serialNumber !== "string") return;
    onState({
      manufacturer: manufacturer ?? object.manufacturer ?? "unknown",
      serialNumber: object.serialNumber,
      body: object,
    });
  });
  void id;
  return () => {
    (master as unknown as { unsubscribe(s: string): Promise<void> }).unsubscribe(id).catch(() => {});
  };
}

/**
 * Live robot poses from state traffic. With a manufacturer, only that
 * maker's robots; without, all of them (the lib wildcards missing
 * subject fields). Resolves each robot's latest pose into the callback.
 */
export async function watchRobots(
  master: MasterController,
  manufacturer: string | undefined,
  onPose: (pose: RobotPose) => void,
): Promise<() => void> {
  const access = master as unknown as TopicAccess;
  const subject = manufacturer === undefined ? {} : { manufacturer };
  const id = await access.subscribeTopic(Topic.State, subject, (object) => {
    if (typeof object.serialNumber !== "string") return;
    // Sparse states degrade to safe defaults: not charging, unplaced,
    // no e-stop. Callers must never read these as live telemetry.
    onPose({
      manufacturer: manufacturer ?? object.manufacturer ?? "unknown",
      serialNumber: object.serialNumber,
      x: object.agvPosition?.x ?? Number.NaN,
      y: object.agvPosition?.y ?? Number.NaN,
      theta: object.agvPosition?.theta ?? 0,
      driving: object.driving ?? false,
      charging: object.batteryState?.charging ?? false,
      ...(object.batteryState?.batteryCharge === undefined
        ? {}
        : { batteryCharge: object.batteryState.batteryCharge }),
      ...(object.batteryState?.batteryVoltage === undefined
        ? {}
        : { batteryVoltage: object.batteryState.batteryVoltage }),
      positionInitialized: object.agvPosition?.positionInitialized ?? false,
      eStop: object.safetyState?.eStop !== undefined && object.safetyState.eStop !== "NONE",
      fieldViolation: object.safetyState?.fieldViolation ?? false,
      laden: Array.isArray(object.loads) && object.loads.length > 0,
      actions: Array.isArray(object.actionStates)
        ? object.actionStates.flatMap((a) =>
            typeof a.actionId === "string" &&
            typeof a.actionType === "string" &&
            typeof a.actionStatus === "string"
              ? [{ actionId: a.actionId, actionType: a.actionType, actionStatus: a.actionStatus }]
              : [],
          )
        : [],
    });
  });
  void id;
  return () => {
    (master as unknown as { unsubscribe(s: string): Promise<void> }).unsubscribe(id).catch(() => {});
  };
}
