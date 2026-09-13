import { assertValidFilter, matchTopic } from "@fleet-manager/core";
import type { Bus, BusHandler, BusMessage, Subscription } from "@fleet-manager/core";

/**
 * In-memory {@link Bus} with MQTT topic-filter semantics.
 *
 * Delivery is synchronous in subscription order (unlike a real broker),
 * which keeps the browser demo deterministic. No retained messages.
 */
export class MemoryBus implements Bus {
  private nextId = 1;
  private readonly subscriptions = new Map<number, { filter: string; handler: BusHandler }>();
  private closed = false;

  async publish<T = unknown>(topic: string, payload: T): Promise<void> {
    if (this.closed) throw new Error("MemoryBus is closed");
    const message: BusMessage<T> = { topic, payload };
    for (const { filter, handler } of this.subscriptions.values()) {
      if (matchTopic(filter, topic)) {
        (handler as BusHandler<T>)(message);
      }
    }
  }

  async subscribe<T = unknown>(filter: string, handler: BusHandler<T>): Promise<Subscription> {
    if (this.closed) throw new Error("MemoryBus is closed");
    assertValidFilter(filter);
    const id = this.nextId++;
    this.subscriptions.set(id, { filter, handler: handler as BusHandler });
    return {
      unsubscribe: () => {
        this.subscriptions.delete(id);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions.clear();
  }

  /** Test hook: number of active subscriptions. */
  get size(): number {
    return this.subscriptions.size;
  }
}
