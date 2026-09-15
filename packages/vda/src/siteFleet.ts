import { MasterController } from "vda-5050-lib";
import type { ClientOptions } from "vda-5050-lib";
import { buildLocks } from "@fleet-manager/core";
import type { FleetLocks, Site } from "@fleet-manager/core";
import { MemoryHub, attachMemoryTransport } from "./fakeMqtt.js";
import { Fleet } from "./fleet.js";
import type { FleetEvents } from "./fleet.js";

export interface SiteFleet {
  site: Site;
  hub: MemoryHub;
  master: MasterController;
  locks: FleetLocks;
  fleet: Fleet;
  stop(): Promise<void>;
}

const clientOptions = (interfaceName: string, brokerUrl: string): ClientOptions => ({
  interfaceName,
  vdaVersion: "2.0.0",
  transport: { brokerUrl },
  topicObjectValidation: { inbound: false, outbound: false },
});

export interface SiteFleetTransport {
  /** Real broker URL. Absent: in-process memory bus (demo, tests). */
  brokerUrl?: string;
}

/**
 * Boot one site's fleet service: master, locks, and the Fleet
 * dispatcher. Memory bus by default; real MQTT when brokerUrl is set.
 * No robots either way — dispatch and subscriptions work; traversal
 * needs AGVs (real robots or virtual spawns pointed at the broker).
 */
export async function bootSiteFleet(
  site: Site,
  interfaceName: string,
  events: FleetEvents = {},
  transport: SiteFleetTransport = {},
): Promise<SiteFleet> {
  const hub = new MemoryHub();
  const master = new MasterController(
    clientOptions(interfaceName, transport.brokerUrl ?? "mqtt://memory"),
    {},
  );
  if (!transport.brokerUrl) attachMemoryTransport(master, hub);
  await master.start();
  const locks = buildLocks(site);
  const fleet = new Fleet(master, locks, events);
  return {
    site,
    hub,
    master,
    locks,
    fleet,
    stop: async () => {
      await master.stop();
    },
  };
}
