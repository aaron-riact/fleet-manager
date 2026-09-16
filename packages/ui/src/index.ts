// Shared, server-independent UI pieces (reused by the ops app and the demo).
export { FleetMap } from "./FleetMap.js";
export type { RobotDot } from "./FleetMap.js";
export { default as App, Shell } from "./App.js";
export { RobotCards, buildCards } from "./RobotCards.js";
export type { RobotCardModel } from "./RobotCards.js";
export { robotStatus, statusColor, theme } from "./theme.js";
export type { RobotSnapshot, RobotStatus } from "./theme.js";
export { createHttpBackend } from "./backend.js";
export type { Backend, DispatchInput, DispatchWaypoint, EventSourceFactory, LivePose, OrderView, Unsubscribe } from "./backend.js";
export { boundsOf, groupByZone, indexNodes, stationPoses, toSvg, viewBoxFor, zoneColor } from "./map.js";
export type { Bounds } from "./map.js";
