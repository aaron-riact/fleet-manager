/**
 * Opaque work attachments for tour waypoints (VDA-5050 node actions).
 *
 * The navigation framework treats these as pass-through data: it stamps
 * them onto order nodes and lets the AGV's adapter interpret them. Domain
 * behaviour (trolleys, charging, doors) lives in whoever *produces* the
 * attachments and in the adapter that *executes* them — never in dispatch,
 * locking, or the pump.
 */
export interface NodeActionAttachment {
  /** Adapter-defined function, e.g. "pickTrolley". Unknown types are rejected by the AGV. */
  actionType: string;
  actionParameters?: Array<{ key: string; value: unknown }>;
  /**
   * HARD gates traversal until the action ends (dwell for the maneuver);
   * SOFT/NONE let the robot drive on while it runs.
   */
  blockingType: "HARD" | "SOFT" | "NONE";
}
