// Shared, server-independent UI pieces (reused by the ops app and the demo).
export { FleetMap } from "./FleetMap.js";
export type { RobotDot } from "./FleetMap.js";
export { default as App, Shell } from "./App.js";
export { POSE_TTL_MS, RobotCards, buildCards, filterCards, pruneStalePoses, summarizeCards } from "./RobotCards.js";
export type { FleetFilter, RobotCardModel } from "./RobotCards.js";
export { TaskHistory, outcomeColor, selectHistory } from "./TaskHistory.js";
export type { HistoryFilter } from "./TaskHistory.js";
export { TaskBoard } from "./TaskBoard.js";
export { robotStatus, statusColor, theme } from "./theme.js";
export type { RobotSnapshot, RobotStatus } from "./theme.js";
export { createHttpBackend } from "./backend.js";
export type { Backend, ConnectionView, DispatchInput, DispatchWaypoint, EventSourceFactory, HistoryView, LivePose, OrderView, Unsubscribe } from "./backend.js";
export { boundsOf, groupByZone, indexNodes, stationPoses, toSvg, underlayRect, viewBoxFor, zoneColor } from "./map.js";
export type { Bounds } from "./map.js";
