import mqtt from "mqtt";
import type { MqttClient } from "mqtt";
import { assertValidFilter, matchTopic } from "@fleet-manager/core";
import type { Bus, BusHandler, Subscription } from "@fleet-manager/core";

export interface MqttBusOptions {
  url: string;
}

/**
 * MQTT {@link Bus} for real robots. Payloads cross the wire as JSON.
 * Topic filters use the broker's own +/# matching; overlapping local
 * subscriptions are fanned out with the shared {@link matchTopic}.
 */
export class MqttBus implements Bus {
  private client: MqttClient | undefined;
  private connecting: Promise<void> | undefined;
  private readonly subs = new Map<number, { filter: string; handler: BusHandler }>();
  private nextId = 1;

  constructor(private readonly options: MqttBusOptions) {}

  /** Idempotent: concurrent callers share one connection attempt. */
  async connect(): Promise<void> {
    if (this.client) return;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const client = mqtt.connect(this.options.url);
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          client.removeListener("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          client.removeListener("connect", onConnect);
          reject(error);
        };
        client.once("connect", onConnect);
        client.once("error", onError);
      });
    } catch (error) {
      client.end(true);
      throw error;
    }
    // mqtt.js keeps reconnecting after a transport error. Without a
    // listener the EventEmitter turns that error into an uncaught throw
    // and takes the process down with it.
    client.on("error", (error) => console.warn(`mqtt ${this.options.url}:`, error.message));
    client.on("message", (topic, payload) => {
      let data: unknown;
      try {
        data = JSON.parse(payload.toString());
      } catch {
        return;
      }
      for (const { filter, handler } of this.subs.values()) {
        if (matchTopic(filter, topic)) handler({ topic, payload: data });
      }
    });
    this.client = client;
  }

  private requireClient(): MqttClient {
    if (!this.client) throw new Error("MqttBus is not connected (call connect() first)");
    return this.client;
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    const client = this.requireClient();
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async subscribe<T = unknown>(filter: string, handler: BusHandler<T>): Promise<Subscription> {
    const client = this.requireClient();
    assertValidFilter(filter);
    await new Promise<void>((resolve, reject) => {
      client.subscribe(filter, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const id = this.nextId++;
    this.subs.set(id, { filter, handler: handler as BusHandler });
    let done = false;
    return {
      unsubscribe: () => {
        if (done) return;
        done = true;
        this.subs.delete(id);
        if (![...this.subs.values()].some((s) => s.filter === filter)) {
          client.unsubscribe(filter, (error) => {
            if (error) console.warn(`mqtt unsubscribe ${filter}:`, error.message);
          });
        }
      },
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    this.subs.clear();
    if (client) {
      await new Promise<void>((resolve) => {
        client.end(false, () => resolve());
      });
    }
  }
}
