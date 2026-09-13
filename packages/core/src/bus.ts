/**
 * Pluggable message bus.
 *
 * Same surface for the MQTT transport (real robots) and the in-memory
 * transport (browser demo, tests). Topic filters follow MQTT semantics:
 * `+` matches exactly one level, trailing `#` matches the rest.
 */
export interface BusMessage<T = unknown> {
  topic: string;
  payload: T;
}

export type BusHandler<T = unknown> = (message: BusMessage<T>) => void;

export interface Subscription {
  unsubscribe(): void;
}

export interface Bus {
  publish<T = unknown>(topic: string, payload: T): Promise<void>;
  subscribe<T = unknown>(filter: string, handler: BusHandler<T>): Promise<Subscription>;
  close(): Promise<void>;
}

/** Validate an MQTT-style subscription filter (`#` only allowed as last level). */
export function assertValidFilter(filter: string): void {
  if (filter.length === 0) throw new Error(`Invalid topic filter: empty`);
  const levels = filter.split("/");
  levels.forEach((level, i) => {
    if (level.includes("#") && (level !== "#" || i !== levels.length - 1)) {
      throw new Error(`Invalid topic filter "${filter}": '#' must occupy an entire final level`);
    }
    if (level.includes("+") && level !== "+") {
      throw new Error(`Invalid topic filter "${filter}": '+' must occupy an entire level`);
    }
  });
}

/** MQTT topic-filter matching (`+` one level, trailing `#` rest). */
export function matchTopic(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
