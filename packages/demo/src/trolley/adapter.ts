import { ActionStatus, VirtualAgvAdapter } from "vda-5050-lib";
import type {
  ActionContext,
  ActionStatusChangeInfo,
  AgvAdapterDebugger,
  AgvController,
  Load,
  VirtualActionDefinition,
  VirtualAgvAdapterOptions,
} from "vda-5050-lib";
import { TrolleyWorld } from "./world.js";

export const PICK_TROLLEY = "pickTrolley";
export const DROP_TROLLEY = "dropTrolley";

/** Shared maneuver speeds so attachments can estimate action durations. */
export const TROLLEY_DRIVE_MPS = 1;
export const TROLLEY_TURN_RPS = Math.PI / 2;
/** Slack between the motion plan and the action's Running duration. */
export const TROLLEY_DURATION_MARGIN_S = 4;
/** Wrap any angle into (-π, π] so turn targets stay canonical. */
export function normAngle(theta: number): number {
  let a = theta % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
/**
 * The trolley waits this far ahead of the station stance pose, along its
 * facing. Station poses are where the robot stands; the load is at the
 * spot it faces from there.
 */
export const TROLLEY_AHEAD_M = 1;

export interface TrolleyAdapterOptions extends VirtualAgvAdapterOptions {
  /**
   * Shared world: trolley positions and who carries what. Optional so the
   * constructor stays compatible with the generic adapter slot — without
   * one the adapter gets an empty world and every pick fails cleanly.
   */
  world?: TrolleyWorld;
}

type Leg = { kind: "turn"; to: number } | { kind: "drive"; x: number; y: number };

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function params(action: ActionContext["action"]): Record<string, unknown> {
  return Object.fromEntries((action.actionParameters ?? []).map((p) => [p.key, p.value]));
}

/** Shortest signed turn from `from` to `to` (radians, wrapped to ±π). */
export function shortTurn(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * A trolley-aware virtual AGV. Adds pick/drop node actions to the stock
 * virtual adapter; everything else (traversal, charging, pause) is
 * inherited untouched.
 *
 * Motion model: while a pick/drop action runs, a small driver advances a
 * scripted leg plan on its own interval and publishes each step, so the
 * map sees the maneuver as ordinary position reports. The plan always
 * finishes before the action's Running duration expires (the attachments
 * builder sizes it with margin); whichever ends first stops the driver.
 *
 * Load bookkeeping is our own `carried` flag — the base adapter's private
 * load state is unreachable from a subclass, and the `loads` array we
 * publish is what the UI's laden flag reads.
 */
export class TrolleyAdapter extends VirtualAgvAdapter {
  private readonly world: TrolleyWorld;
  private carried: string | undefined;
  private readonly drivers = new Map<string, ReturnType<typeof setInterval>>();
  /** Park angle per in-flight drop, keyed by station. */
  private readonly dropThetas = new Map<string, number>();

  constructor(controller: AgvController, options: TrolleyAdapterOptions, debug: AgvAdapterDebugger) {
    super(controller, options, debug);
    this.world = options.world ?? new TrolleyWorld();
  }

  protected override get actionDefinitions(): VirtualActionDefinition[] {
    return [...super.actionDefinitions, this.pickDef(), this.dropDef()];
  }

  override executeAction(context: ActionContext): void {
    const { action, scope } = context;
    if (scope !== "node" || (action.actionType !== PICK_TROLLEY && action.actionType !== DROP_TROLLEY)) {
      super.executeAction(context);
      return;
    }
    // The base rejects failed preconditions synchronously through
    // updateActionStatus — watch for that so we only drive accepted actions.
    // The same wrapper later sees the terminal transition and stops the
    // driver even if our plan overruns its duration estimate.
    const wrapped: ActionContext = {
      ...context,
      updateActionStatus: (change: ActionStatusChangeInfo) => {
        if (change.actionStatus === ActionStatus.Finished || change.actionStatus === ActionStatus.Failed) {
          this.stopDriver(action.actionId);
        }
        context.updateActionStatus(change);
      },
    };
    let accepted = true;
    const guard: ActionContext = {
      ...wrapped,
      updateActionStatus: (change: ActionStatusChangeInfo) => {
        if (change.actionStatus === ActionStatus.Failed) accepted = false;
        wrapped.updateActionStatus(change);
      },
    };
    super.executeAction(guard);
    if (accepted) this.startDriver(action.actionId, action.actionType, params(action));
  }

  override cancelAction(context: ActionContext): void {
    this.stopDriver(context.action.actionId);
    super.cancelAction(context);
  }

  override detach(context: Parameters<VirtualAgvAdapter["detach"]>[0]): void {
    for (const id of [...this.drivers.keys()]) this.stopDriver(id);
    super.detach(context);
  }

  private pickDef(): VirtualActionDefinition {
    return {
      actionType: PICK_TROLLEY,
      actionScopes: "node",
      actionParameterConstraints: {
        station: (v) => str(v) !== undefined,
        stanceX: (v) => num(v) !== undefined,
        stanceY: (v) => num(v) !== undefined,
        stanceTheta: (v) => num(v) !== undefined,
        dockX: (v) => num(v) !== undefined,
        dockY: (v) => num(v) !== undefined,
        duration: (v) => v === undefined || num(v) !== undefined,
      },
      actionExecutable: (action) => {
        const p = params(action);
        if (this.carried !== undefined) return `already carrying trolley "${this.carried}"`;
        const station = str(p["station"]);
        if (station === undefined) return "missing station parameter";
        const trolley = this.world.trolleyAt(station);
        return trolley === undefined ? `no trolley at station "${station}"` : "";
      },
      transitions: {
        ON_INIT: { next: ActionStatus.Initializing },
        ON_CANCEL: {},
        [ActionStatus.Initializing]: { durationTime: 1, next: ActionStatus.Running },
        [ActionStatus.Running]: { durationTime: ["duration", 8], next: ActionStatus.Finished },
        [ActionStatus.Finished]: {
          resultDescription: () => "pickTrolley finished",
          // Resolve the trolley at finish time, not at action start: the
          // world may have changed while driving here (locked nodes make
          // this near-impossible, but the check is one line).
          linkedState: (context) => this.finishPick(str(params(context.action)["station"])),
        },
        [ActionStatus.Failed]: {
          errorDescription: () => "pickTrolley failed",
        },
      },
    };
  }

  private dropDef(): VirtualActionDefinition {
    return {
      actionType: DROP_TROLLEY,
      actionScopes: "node",
      actionParameterConstraints: {
        station: (v) => str(v) !== undefined,
        stanceX: (v) => num(v) !== undefined,
        stanceY: (v) => num(v) !== undefined,
        dockX: (v) => num(v) !== undefined,
        dockY: (v) => num(v) !== undefined,
        dockTheta: (v) => num(v) !== undefined,
        trolleyTheta: (v) => num(v) !== undefined,
        exitDist: (v) => num(v) !== undefined && (v as number) >= 0,
        duration: (v) => v === undefined || num(v) !== undefined,
      },
      actionExecutable: (action) => {
        if (this.carried === undefined) return "no load to drop";
        const p = params(action);
        const station = str(p["station"]);
        if (station === undefined) return "missing station parameter";
        const occupant = this.world.trolleyAt(station);
        return occupant !== undefined && occupant !== this.carried
          ? `station "${station}" already holds trolley "${occupant}"`
          : "";
      },
      transitions: {
        ON_INIT: { next: ActionStatus.Initializing },
        ON_CANCEL: {},
        [ActionStatus.Initializing]: { durationTime: 1, next: ActionStatus.Running },
        [ActionStatus.Running]: { durationTime: ["duration", 12], next: ActionStatus.Finished },
        [ActionStatus.Finished]: {
          resultDescription: () => "dropTrolley finished",
          linkedState: (context) => this.finishDrop(str(params(context.action)["station"])),
        },
        [ActionStatus.Failed]: {
          errorDescription: () => "dropTrolley failed",
        },
      },
    };
  }

  private finishPick(station: string | undefined): { loads: Load[] } {
    const serial = this.controller.agvId.serialNumber ?? "unknown";
    const picked = station === undefined ? undefined : this.world.trolleyAt(station);
    if (picked === undefined || this.world.carrierOf(picked) !== undefined) return { loads: [] };
    this.world.attach(picked, serial);
    this.carried = picked;
    return {
      loads: [
        {
          loadId: picked,
          loadType: "Trolley",
          loadDimensions: { length: 1, width: 0.8, height: 1.2 },
          weight: 50,
        },
      ],
    };
  }

  private finishDrop(station: string | undefined): { loads: Load[] } {
    const load = this.carried;
    this.carried = undefined;
    if (load === undefined) return { loads: [] };
    if (station !== undefined) {
      // The trolley parks perpendicular to the stance facing: its long
      // side faces the triangle. Captured at action start so the angle
      // never depends on where the motion happened to end.
      const theta = this.dropThetas.get(station) ?? 0;
      this.dropThetas.delete(station);
      try {
        this.world.place(station, load, theta);
      } catch {
        // Occupied mid-maneuver (shouldn't happen under node locks): keep
        // the load rather than lose a trolley.
        this.carried = load;
        return {
          loads: [{ loadId: load, loadType: "Trolley" }],
        };
      }
    }
    return { loads: [] };
  }

  private startDriver(actionId: string, type: string, p: Record<string, unknown>): void {
    this.stopDriver(actionId);
    const start = this.vehicleState.position;
    const stanceX = num(p["stanceX"])!;
    const stanceY = num(p["stanceY"])!;
    const stanceTheta = num(p["stanceTheta"])!;
    const dockX = num(p["dockX"])!;
    const dockY = num(p["dockY"])!;
    // Turn legs that are already aligned complete instantly at execution.
    const legs: Leg[] = [];
    if (type === PICK_TROLLEY) {
      // To the triangle, face where it points, to the trolley, match its
      // angle — then the pick engages and the tour drives on from there.
      const trolleyTheta = this.world.trolleyPose(str(p["station"]) ?? "")?.theta;
      legs.push({ kind: "drive", x: stanceX, y: stanceY });
      legs.push({ kind: "turn", to: stanceTheta });
      legs.push({ kind: "drive", x: dockX, y: dockY });
      if (trolleyTheta !== undefined) legs.push({ kind: "turn", to: trolleyTheta });
    } else {
      // To the slot, release, face back toward the drop stance and exit
      // onto it — the route drives on with no return trip. The trolley
      // keeps the segment angle from the action params.
      const dockTheta = num(p["dockTheta"])!;
      const exitDist = num(p["exitDist"]) ?? 0;
      const back = Math.atan2(stanceY - dockY, stanceX - dockX);
      const station = str(p["station"]);
      const trolleyTheta = num(p["trolleyTheta"]);
      if (station !== undefined && trolleyTheta !== undefined) this.dropThetas.set(station, trolleyTheta);
      legs.push({ kind: "turn", to: dockTheta });
      legs.push({ kind: "drive", x: dockX, y: dockY });
      legs.push({ kind: "turn", to: back });
      legs.push({
        kind: "drive",
        x: dockX + Math.cos(back) * exitDist,
        y: dockY + Math.sin(back) * exitDist,
      });
    }
    this.startDriving(0, 0, true);
    let x = start.x;
    let y = start.y;
    let theta = start.theta;
    let leg = 0;
    const step = 0.2;
    const timer = setInterval(() => {
      const current = legs[leg];
      if (!current) {
        this.stopDriver(actionId);
        return;
      }
      if (current.kind === "turn") {
        const remaining = shortTurn(theta, current.to);
        const move = Math.sign(remaining) * Math.min(Math.abs(remaining), TROLLEY_TURN_RPS * step);
        theta += move;
        if (Math.abs(shortTurn(theta, current.to)) < 0.01) {
          theta = current.to;
          leg += 1;
        }
        this.publish(x, y, theta, 0, 0);
      } else {
        const dx = current.x - x;
        const dy = current.y - y;
        const dist = Math.hypot(dx, dy);
        const move = Math.min(dist, TROLLEY_DRIVE_MPS * step);
        const nx = dist === 0 ? x : x + (dx / dist) * move;
        const ny = dist === 0 ? y : y + (dy / dist) * move;
        this.updateBatteryState(nx - x, ny - y);
        x = nx;
        y = ny;
        if (move >= dist - 1e-9) leg += 1;
        this.publish(x, y, theta, Math.cos(theta) * TROLLEY_DRIVE_MPS, Math.sin(theta) * TROLLEY_DRIVE_MPS);
      }
    }, step * 1000);
    this.drivers.set(actionId, timer);
  }

  private publish(x: number, y: number, theta: number, vx: number, vy: number): void {
    this.controller.updateAgvPositionVelocity(
      { mapId: "local", x, y, theta, positionInitialized: true },
      { vx, vy },
      true,
    );
    // Mirror into the adapter's own position. The controller state above
    // is what the map shows, but traversal resumes from the adapter's
    // internal pose — without this the next edge starts at the stale
    // arrival node and the robot visibly teleports back to it.
    const internal = this.vehicleState as unknown as { position: { x: number; y: number; theta: number } };
    internal.position.x = x;
    internal.position.y = y;
    internal.position.theta = theta;
  }

  private stopDriver(actionId: string): void {
    const timer = this.drivers.get(actionId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.drivers.delete(actionId);
    try {
      this.stopDriving(true);
    } catch {
      // Detach/shutdown path: the controller may already be gone.
    }
  }
}
