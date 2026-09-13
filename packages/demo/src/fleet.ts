import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvId, ClientOptions } from "vda-5050-lib";
import { MemoryHub, attachMemoryTransport } from "@fleet-manager/vda";

export interface DemoRobot {
  id: AgvId;
  controller: AgvController;
}

export interface DemoFleet {
  hub: MemoryHub;
  master: MasterController;
  robots: DemoRobot[];
  stop(): Promise<void>;
}

const clientOptions = (interfaceName: string): ClientOptions => ({
  interfaceName,
  vdaVersion: "2.0.0",
  transport: { brokerUrl: "mqtt://memory" },
  topicObjectValidation: { inbound: false, outbound: false },
});

/**
 * Boot a whole fleet in-process: one master plus virtual AGVs,
 * all talking over a MemoryHub. No broker, no server.
 * Runs in Node/Bun and in browsers (no Node APIs inside).
 */
export async function bootFleet(input: {
  interfaceName?: string;
  robots?: Array<{ manufacturer: string; serialNumber: string }>;
} = {}): Promise<DemoFleet> {
  const interfaceName = input.interfaceName ?? "demo";
  const specs = input.robots ?? [{ manufacturer: "RobotCompany", serialNumber: "demo-1" }];
  const hub = new MemoryHub();
  const master = new MasterController(clientOptions(interfaceName), {});
  attachMemoryTransport(master, hub);
  await master.start();

  const robots: DemoRobot[] = [];
  for (const { manufacturer, serialNumber } of specs) {
    const id: AgvId = { manufacturer, serialNumber };
    const controller = new AgvController(
      id,
      clientOptions(interfaceName),
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 250 },
      { vehicleSpeed: 2 },
    );
    attachMemoryTransport(controller, hub);
    await controller.start();
    robots.push({ id, controller });
  }

  return {
    hub,
    master,
    robots,
    async stop() {
      for (const { controller } of robots) await controller.stop();
      await master.stop();
    },
  };
}
