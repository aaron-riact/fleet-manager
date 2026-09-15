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

const clientOptions = (interfaceName: string): ClientOptions => ({
  interfaceName,
  vdaVersion: "2.0.0",
  transport: { brokerUrl: "mqtt://memory" },
  topicObjectValidation: { inbound: false, outbound: false },
});

/**
 * Boot one site's fleet service: memory bus, master, locks, and the
 * Fleet dispatcher. No robots, no broker — dispatch and subscriptions
 * work; traversal needs AGVs (real via MQTT later, virtual in demo).
 */
export async function bootSiteFleet(
  site: Site,
  interfaceName: string,
  events: FleetEvents = {},
): Promise<SiteFleet> {
  const hub = new MemoryHub();
  const master = new MasterController(clientOptions(interfaceName), {});
  attachMemoryTransport(master, hub);
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
