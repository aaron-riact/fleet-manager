import { describe, expect, test } from "bun:test";
import { AgvClient, MasterControlClient, Topic } from "vda-5050-lib";
import type { ClientOptions } from "vda-5050-lib";
import { MemoryHub, attachMemoryTransport } from "../src/fakeMqtt.js";

const options: ClientOptions = {
  interfaceName: "test",
  vdaVersion: "2.0.0",
  transport: { brokerUrl: "mqtt://memory" },
  topicObjectValidation: { inbound: false, outbound: false },
};

const agvId = { manufacturer: "RobotCompany", serialNumber: "mem-1" };

/** subscribeTopic/publishTopic are public at runtime, protected in types. */
interface TopicAccess {
  subscribeTopic(
    topic: Topic,
    subject: typeof agvId,
    handler: (object: unknown) => void,
  ): Promise<string>;
  publishTopic(topic: Topic, subject: typeof agvId, object: unknown): Promise<unknown>;
}

describe("memory transport seam", () => {
  test("master and AGV exchange state with headers, no broker", async () => {
    const hub = new MemoryHub();
    const master = new MasterControlClient(options);
    const agv = new AgvClient(agvId, options);
    attachMemoryTransport(master, hub);
    attachMemoryTransport(agv, hub);
    await master.start();
    await agv.start();

    const received: unknown[] = [];
    await (master as unknown as TopicAccess).subscribeTopic(Topic.State, agvId, (object) => {
      received.push(object);
    });

    const published = await (agv as unknown as TopicAccess).publishTopic(Topic.State, agvId, {
      custom: "ping",
    });
    expect(published).toMatchObject({ manufacturer: "RobotCompany", serialNumber: "mem-1" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ custom: "ping", manufacturer: "RobotCompany" });

    await master.stop();
    await agv.stop();
  });
});
