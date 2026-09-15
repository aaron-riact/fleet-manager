// Shared, server-independent UI pieces (reused by the ops app and the demo).
export { FleetMap } from "./FleetMap.js";
export type { RobotDot } from "./FleetMap.js";
export { default as App, Shell } from "./App.js";
export { createHttpBackend } from "./backend.js";
export type { Backend } from "./backend.js";
export { boundsOf, indexNodes, toSvg, viewBoxFor } from "./map.js";
export type { Bounds } from "./map.js";
