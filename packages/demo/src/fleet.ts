import { AgvController, MasterController, VirtualAgvAdapter } from "vda-5050-lib";
import type { AgvAdapterConstructor, AgvId, ClientOptions, VirtualAgvAdapterOptions } from "vda-5050-lib";
import { MemoryHub, attachMemoryTransport } from "@fleet-manager/vda";

export interface DemoRobot {
  id: AgvId;
  controller: AgvController;
}

export interface SpawnSpec {
  manufacturer: string;
  serialNumber: string;
  /** Start pose; defaults to the origin. Put robots on the loop they will drive. */
  x?: number;
  y?: number;
}

export interface DemoFleet {
  hub: MemoryHub;
  master: MasterController;
  robots: DemoRobot[];
  /** Spawn an extra virtual robot at runtime. */
  spawn(spec: SpawnSpec): Promise<DemoRobot>;
  /** Remove a robot (stops its controller). Returns false if unknown. */
  drop(serialNumber: string): Promise<boolean>;
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
  robots?: SpawnSpec[];
  /**
   * Adapter class for the virtual robots (default VirtualAgvAdapter).
   * Custom adapters (trolleys, doors, …) plug in here; extra constructor
   * needs travel via adapterOptions.
   */
  adapterType?: AgvAdapterConstructor;
  adapterOptions?: Partial<VirtualAgvAdapterOptions> & Record<string, unknown>;
} = {}): Promise<DemoFleet> {
  const interfaceName = input.interfaceName ?? "demo";
  const specs = input.robots ?? [{ manufacturer: "RobotCompany", serialNumber: "demo-1" }];
  const hub = new MemoryHub();
  const master = new MasterController(clientOptions(interfaceName), {});
  attachMemoryTransport(master, hub);
  await master.start();

  const robots: DemoRobot[] = [];

  async function spawn(spec: SpawnSpec): Promise<DemoRobot> {
    if (robots.some((r) => r.id.serialNumber === spec.serialNumber)) {
      throw new Error(`robot already exists: "${spec.serialNumber}"`);
    }
    const id: AgvId = { manufacturer: spec.manufacturer, serialNumber: spec.serialNumber };
    const controller = new AgvController(
      id,
      clientOptions(interfaceName),
      { agvAdapterType: input.adapterType ?? VirtualAgvAdapter, publishStateInterval: 250 },
      {
        vehicleSpeed: 3,
        initialPosition: { mapId: "local", x: spec.x ?? 0, y: spec.y ?? 0, theta: 0, lastNodeId: "0" },
        ...input.adapterOptions,
      },
    );
    attachMemoryTransport(controller, hub);
    await controller.start();
    const robot = { id, controller };
    robots.push(robot);
    return robot;
  }

  for (const spec of specs) await spawn(spec);

  return {
    hub,
    master,
    robots,
    spawn,
    async drop(serialNumber: string): Promise<boolean> {
      const index = robots.findIndex((r) => r.id.serialNumber === serialNumber);
      if (index < 0) return false;
      const [robot] = robots.splice(index, 1);
      await robot!.controller.stop();
      return true;
    },
    async stop() {
      for (const { controller } of robots) await controller.stop();
      await master.stop();
    },
  };
}
