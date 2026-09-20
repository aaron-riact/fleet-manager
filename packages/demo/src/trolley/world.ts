/**
 * Demo world state: which trolley sits at which station, and which robot
 * carries what. The navigation framework never sees this — the trolley
 * adapter consults it when a pick/drop action starts, and the attachments
 * builder only reads site geometry. Stations are site-location ids;
 * carriers are robot serial numbers.
 */
export class TrolleyWorld {
  private readonly atStation = new Map<string, string>();
  private readonly onRobot = new Map<string, string>();

  /** Park a trolley at a station (seed layout or after a drop elsewhere). */
  seed(station: string, trolleyId: string): void {
    if (this.onRobot.has(trolleyId)) throw new Error(`trolley "${trolleyId}" is on a robot, cannot seed at "${station}"`);
    const occupant = this.atStation.get(station);
    if (occupant !== undefined && occupant !== trolleyId) {
      throw new Error(`station "${station}" already holds trolley "${occupant}"`);
    }
    this.atStation.set(station, trolleyId);
  }

  /** Trolley waiting at a station, if any. Carried trolleys are not "at" stations. */
  trolleyAt(station: string): string | undefined {
    return this.atStation.get(station);
  }

  /** Who carries a trolley, if anyone. */
  carrierOf(trolleyId: string): string | undefined {
    return this.onRobot.get(trolleyId);
  }

  /** Lift a trolley off its station onto a robot. Throws when inconsistent. */
  attach(trolleyId: string, carrier: string): void {
    if (this.onRobot.has(trolleyId)) throw new Error(`trolley "${trolleyId}" is already carried`);
    for (const [station, id] of this.atStation) {
      if (id === trolleyId) this.atStation.delete(station);
    }
    this.onRobot.set(trolleyId, carrier);
  }

  /** Set a trolley down at a station. Throws when the station is occupied. */
  place(station: string, trolleyId: string): void {
    const occupant = this.atStation.get(station);
    if (occupant !== undefined && occupant !== trolleyId) {
      throw new Error(`station "${station}" already holds trolley "${occupant}"`);
    }
    this.onRobot.delete(trolleyId);
    this.atStation.set(station, trolleyId);
  }

  stations(): string[] {
    return [...this.atStation.keys()];
  }

  /** Trolleys currently riding robots (for markers that follow the carrier). */
  aboard(): Array<{ trolleyId: string; carrier: string }> {
    return [...this.onRobot.entries()].map(([trolleyId, carrier]) => ({ trolleyId, carrier }));
  }
}
