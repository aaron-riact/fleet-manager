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
    }) => void,
  ): Promise<string>;
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
    });
  });
  void id;
  return () => {
    (master as unknown as { unsubscribe(s: string): Promise<void> }).unsubscribe(id).catch(() => {});
  };
}
