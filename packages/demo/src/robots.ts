import { Topic } from "vda-5050-lib";
import type { MasterController } from "vda-5050-lib";

export interface RobotPose {
  manufacturer: string;
  serialNumber: string;
  x: number;
  y: number;
  theta: number;
  driving: boolean;
}

interface TopicAccess {
  subscribeTopic(
    topic: Topic,
    subject: { manufacturer: string; serialNumber?: string },
    handler: (object: {
      manufacturer?: string;
      serialNumber?: string;
      agvPosition?: { x?: number; y?: number; theta?: number };
      driving?: boolean;
    }) => void,
  ): Promise<string>;
}

/**
 * Live robot poses from state traffic (demo director panel + map).
 * Resolves each robot's latest pose into the callback.
 */
export async function watchRobots(
  master: MasterController,
  manufacturer: string,
  onPose: (pose: RobotPose) => void,
): Promise<() => void> {
  const access = master as unknown as TopicAccess;
  const id = await access.subscribeTopic(Topic.State, { manufacturer }, (object) => {
    if (typeof object.serialNumber !== "string") return;
    onPose({
      manufacturer,
      serialNumber: object.serialNumber,
      x: object.agvPosition?.x ?? Number.NaN,
      y: object.agvPosition?.y ?? Number.NaN,
      theta: object.agvPosition?.theta ?? 0,
      driving: object.driving ?? false,
    });
  });
  void id;
  return () => {
    (master as unknown as { unsubscribe(s: string): Promise<void> }).unsubscribe(id).catch(() => {});
  };
}
