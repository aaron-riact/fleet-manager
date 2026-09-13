/**
 * Browser stub for the `mqtt` package.
 *
 * vda-5050-lib requires mqtt at module load, which pulls Node-only code
 * (mqtt-packet needs Buffer) into browser bundles. The demo never uses
 * real MQTT — everything goes through the memory transport seam — so
 * this stub only exists to satisfy the import. Any actual call is a bug.
 */
export function connect(): never {
  throw new Error("mqtt is unavailable in this bundle (memory transport only)");
}

export default { connect };
