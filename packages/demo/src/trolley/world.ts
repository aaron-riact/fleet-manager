/**
 * Initial trolley layout per site (station/location ids). Deliberately
 * sparse: most stations start empty so picks there demo the failure path
 * and drops rarely collide with a parked trolley.
 */
export const DEFAULT_TROLLEY_SEED: Record<string, string[]> = {
  coalescent: ["originwall1", "television"],
  demo: ["dock-1", "dock-2"],
};

export interface TrolleyPose {
  id: string;
  /** Long-axis heading the robot must match to slide under. */
  theta: number;
}

/**
 * Demo world state: which trolley sits at which station (with its angle),
 * and which robot carries what. The navigation framework never sees this —
 * the trolley adapter consults it when a pick/drop action starts, and the
 * attachments builder only reads site geometry. Stations are
 * site-location ids; carriers are robot serial numbers.
 */
export class TrolleyWorld {
  private readonly atStation = new Map<string, TrolleyPose>();
  private readonly onRobot = new Map<string, { carrier: string; theta: number }>();

  /** Park a trolley at a station (seed layout or after a drop elsewhere). */
  seed(station: string, trolleyId: string, theta = 0): void {
    if (this.onRobot.has(trolleyId)) throw new Error(`trolley "${trolleyId}" is on a robot, cannot seed at "${station}"`);
    const occupant = this.atStation.get(station);
    if (occupant !== undefined && occupant.id !== trolleyId) {
      throw new Error(`station "${station}" already holds trolley "${occupant.id}"`);
    }
    this.atStation.set(station, { id: trolleyId, theta });
  }

  /** Trolley waiting at a station, if any. Carried trolleys are not "at" stations. */
  trolleyAt(station: string): string | undefined {
    return this.atStation.get(station)?.id;
  }

  /** Trolley plus its long-axis angle at a station, if any. */
  trolleyPose(station: string): TrolleyPose | undefined {
    return this.atStation.get(station);
  }

  /** Who carries a trolley, if anyone. */
  carrierOf(trolleyId: string): string | undefined {
    return this.onRobot.get(trolleyId)?.carrier;
  }

  /** Lift a trolley off its station onto a robot, keeping its angle. */
  attach(trolleyId: string, carrier: string): void {
    if (this.onRobot.has(trolleyId)) throw new Error(`trolley "${trolleyId}" is already carried`);
    const pose = [...this.atStation.entries()].find(([, p]) => p.id === trolleyId);
    if (pose) this.atStation.delete(pose[0]);
    this.onRobot.set(trolleyId, { carrier, theta: pose?.[1].theta ?? 0 });
  }

  /** Set a trolley down at a station under its current heading. */
  place(station: string, trolleyId: string, theta: number): void {
    const occupant = this.atStation.get(station);
    if (occupant !== undefined && occupant.id !== trolleyId) {
      throw new Error(`station "${station}" already holds trolley "${occupant.id}"`);
    }
    this.onRobot.delete(trolleyId);
    this.atStation.set(station, { id: trolleyId, theta });
  }

  stations(): string[] {
    return [...this.atStation.keys()];
  }

  /** Trolleys currently riding robots (for markers that follow the carrier). */
  aboard(): Array<{ trolleyId: string; carrier: string; theta: number }> {
    return [...this.onRobot.entries()].map(([trolleyId, { carrier, theta }]) => ({
      trolleyId,
      carrier,
      theta,
    }));
  }
}
