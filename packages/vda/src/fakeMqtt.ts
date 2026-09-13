import { matchTopic } from "@fleet-manager/core";

/**
 * In-memory stand-in for an mqtt.js client, shared between vda-5050-lib
 * clients via a {@link MemoryHub}. Attach with {@link attachMemoryTransport}.
 *
 * Only implements the surface vda-5050-lib's Client uses: connected,
 * publish/subscribe/unsubscribe/end plus basic event methods.
 * No Node APIs — safe for browser bundles.
 */

export type MessageForwarder = (topic: string, payload: Uint8Array) => void;

export class MemoryHub {
  private nextId = 1;
  private readonly subscriptions = new Map<number, { filter: string; forward: MessageForwarder }>();

  subscribe(filter: string, forward: MessageForwarder): () => void {
    const id = this.nextId++;
    this.subscriptions.set(id, { filter, forward });
    return () => {
      this.subscriptions.delete(id);
    };
  }

  publish(topic: string, payload: string | Uint8Array): void {
    // TextBytes mimics an MQTT Buffer: raw bytes whose toString() is UTF-8 text.
    const bytes =
      typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    const text = new TextDecoder().decode(bytes);
    const framed = new TextBytes(bytes, text);
    for (const { filter, forward } of this.subscriptions.values()) {
      if (matchTopic(filter, topic)) forward(topic, framed);
    }
  }
}

/** Uint8Array with Buffer-like UTF-8 toString (what mqtt.js delivers). */
class TextBytes extends Uint8Array {
  constructor(
    bytes: Uint8Array,
    private readonly text: string,
  ) {
    super(bytes);
  }

  override toString(): string {
    return this.text;
  }
}

type Listener = (...args: never[]) => void;

/** Minimal mqtt.js-shaped client backed by a MemoryHub. */
export class FakeMqttClient {
  connected = true;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly hubUnsubscribes = new Map<string, Array<() => void>>();

  constructor(
    private readonly hub: MemoryHub,
    private readonly onMessage: MessageForwarder,
  ) {}

  on(event: string, listener: Listener): this {
    this.listeners.get(event)?.add(listener) ?? this.listeners.set(event, new Set([listener]));
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper = (...args: never[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  prependListener(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    this.listeners.set(event, new Set([listener, ...set]));
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  publish(
    topic: string,
    payload: string | Uint8Array,
    _opts?: unknown,
    callback?: (err?: Error) => void,
  ): void {
    this.hub.publish(topic, payload);
    callback?.();
  }

  subscribe(topic: string | string[], _opts?: unknown, callback?: (err?: Error) => void): void {
    for (const t of Array.isArray(topic) ? topic : [topic]) {
      const unsub = this.hub.subscribe(t, (msgTopic, bytes) => this.onMessage(msgTopic, bytes));
      const list = this.hubUnsubscribes.get(t) ?? [];
      list.push(unsub);
      this.hubUnsubscribes.set(t, list);
    }
    callback?.();
  }

  unsubscribe(topic: string, callback?: (err?: Error) => void): void {
    for (const unsub of this.hubUnsubscribes.get(topic) ?? []) unsub();
    this.hubUnsubscribes.delete(topic);
    callback?.();
  }

  end(_force?: boolean, callback?: () => void): void {
    this.connected = false;
    callback?.();
  }
}

/** vda-5050-lib client surface we touch (its real members are TS-private). */
interface MqttBacked {
  _subscriptionManager: { getAll(): string[] };
  _emitConnectionStateChange(state: "online" | "offline" | "broken"): void;
}

/**
 * Point a vda-5050-lib client (MasterControlClient, AgvClient, or the
 * controllers extending them) at a MemoryHub instead of a broker.
 * Overrides the private `_connect`; everything above it (validation,
 * headers, subscription manager, controller logic) runs untouched.
 */
export function attachMemoryTransport(client: object, hub: MemoryHub): void {
  const c = client as MqttBacked & { _mqtt?: unknown; _connect?: () => Promise<void> };
  c._connect = async () => {
    const fake = new FakeMqttClient(hub, (topic, bytes) =>
      (client as unknown as { _dispatchMessage(t: string, p: Uint8Array): void })._dispatchMessage(
        topic,
        bytes,
      ),
    );
    c._mqtt = fake;
    for (const mqttTopic of c._subscriptionManager.getAll()) fake.subscribe(mqttTopic, {});
    c._emitConnectionStateChange("online");
  };
}
