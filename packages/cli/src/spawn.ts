import { AgvController, VirtualAgvAdapter } from "vda-5050-lib";

export interface SpawnOptions {
  brokerUrl: string;
  interfaceName: string;
  manufacturer?: string;
  serial: string;
  x?: number;
  y?: number;
  /** Stops the robot when the signal fires (SIGINT in the CLI). */
  signal?: AbortSignal;
}

/** Run one virtual robot until the signal aborts. Resolves on clean stop. */
export async function spawnRobot(options: SpawnOptions): Promise<void> {
  const {
    brokerUrl,
    interfaceName,
    manufacturer = "RobotCompany",
    serial,
    x = 0,
    y = 0,
    signal,
  } = options;
  if (!serial) throw new Error("serial is required");
  const controller = new AgvController(
    { manufacturer, serialNumber: serial },
    {
      interfaceName,
      vdaVersion: "2.0.0",
      transport: { brokerUrl },
      topicObjectValidation: { inbound: false, outbound: false },
    },
    { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 1000 },
    {
      vehicleSpeed: 2,
      initialPosition: { mapId: "local", x, y, theta: 0, lastNodeId: "0" },
    },
  );
  await controller.start();
  if (signal?.aborted) {
    await controller.stop();
    return;
  }
  await new Promise<void>((resolve) => {
    if (!signal) return;
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await controller.stop();
}
