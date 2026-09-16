import React, { useMemo } from "react";
import type { LockSnapshot, ParkingSpot, Site } from "@fleet-manager/core";
import { boundsOf, groupByZone, indexNodes, stationPoses, toSvg, viewBoxFor, zoneColor } from "./map";

export interface RobotDot {
  serialNumber: string;
  x: number;
  y: number;
}

export interface OrderWait {
  serialNumber: string;
  /** First unreleased node in the robot's own order. */
  nodeId: string;
}

/** Graph overlay: edges under nodes, positions in meters. */
export function FleetMap({
  site,
  robots = [],
  locks,
  parking = [],
  waits = [],
}: {
  site: Site;
  robots?: RobotDot[];
  locks?: LockSnapshot;
  parking?: ParkingSpot[];
  /** Robots waiting, each with the node from its own order it waits on. */
  waits?: OrderWait[];
}) {
  const bounds = useMemo(() => boundsOf(site), [site]);
  const byId = useMemo(() => indexNodes(site.nodes), [site]);
  const nodeState = useMemo(() => new Map((locks?.nodeLocks ?? []).map((n) => [n.id, n])), [locks]);
  const edgeHeld = useMemo(() => {
    const set = new Set<string>();
    for (const e of locks?.edgeLocks ?? []) if (e.held) set.add(`${e.fromId}→${e.toId}`);
    return set;
  }, [locks]);

  return (
    <svg
      viewBox={viewBoxFor(bounds, 1.5)}
      role="img"
      aria-label={`Map of ${site.name}`}
      style={{ width: "100%", height: "auto", background: "#0b0e14", borderRadius: 12 }}
    >
      <g id="graph-edges" strokeWidth={0.08}>
        {site.links.map((link, i) => {
          const from = byId.get(link.source);
          const to = byId.get(link.destination);
          if (!from || !to) return null;
          const a = toSvg(from.x, from.y, bounds);
          const b = toSvg(to.x, to.y, bounds);
          const held =
            edgeHeld.has(`${link.source}→${link.destination}`) ||
            edgeHeld.has(`${link.destination}→${link.source}`);
          return (
            <line
              key={`${link.source}-${link.destination}-${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={held ? "#f0883e" : "#3b4657"}
            />
          );
        })}
        {(locks?.edgeLocks ?? []).flatMap((edge) =>
          edge.legs
            .filter((leg) => leg.owners.length > 0)
            .map((leg) => {
              const origin = byId.get(leg.from);
              const otherId = leg.from === edge.fromId ? edge.toId : edge.fromId;
              const other = byId.get(otherId);
              if (!origin || !other) return null;
              const a = toSvg(origin.x, origin.y, bounds);
              const b = toSvg(other.x, other.y, bounds);
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              const ang = Math.atan2(b.y - a.y, b.x - a.x);
              const s = 0.28;
              const tip = `${(mx + Math.cos(ang) * s).toFixed(3)},${(my + Math.sin(ang) * s).toFixed(3)}`;
              const l = `${(mx + Math.cos(ang + 2.5) * s).toFixed(3)},${(my + Math.sin(ang + 2.5) * s).toFixed(3)}`;
              const r = `${(mx + Math.cos(ang - 2.5) * s).toFixed(3)},${(my + Math.sin(ang - 2.5) * s).toFixed(3)}`;
              return <polygon key={`${edge.fromId}-${edge.toId}-${leg.from}`} points={`${tip} ${l} ${r}`} fill="#f0883e" />;
            }),
        )}
      </g>
      <g id="graph-nodes">
        {site.nodes.map((node) => {
          const p = toSvg(node.x, node.y, bounds);
          const state = nodeState.get(node.id);
          const held = (state?.owners.length ?? 0) > 0;
          const contested = !held && (state?.waiters.length ?? 0) > 0;
          return (
            <g key={node.id} id={`node-${node.id}`}>
              <circle
                cx={p.x}
                cy={p.y}
                r={node.radius ?? 0.25}
                fill={held ? "#f0883e22" : "#0b0e14"}
                stroke={held ? "#f0883e" : contested ? "#e3b341" : "#8b949e"}
                strokeWidth={0.06}
                strokeDasharray={contested ? "0.15 0.1" : undefined}
              />
              <text
                x={p.x}
                y={p.y - (node.radius ?? 0.25) - 0.15}
                textAnchor="middle"
                fontSize={0.3}
                fill="#8b949e"
                stroke="#0b0e14"
                strokeWidth={0.06}
                style={{ paintOrder: "stroke" }}
              >
                {node.id}
              </text>
            </g>
          );
        })}
      </g>
      <g id="parking">
        {parking.map((spot) => {
          const p = toSvg(spot.x, spot.y, bounds);
          const s = 0.35;
          const entry = spot.entry ? byId.get(spot.entry) : undefined;
          const e = entry ? toSvg(entry.x, entry.y, bounds) : undefined;
          return (
            <g key={spot.id} id={`park-${spot.id}`}>
              {e && (
                <line
                  x1={p.x.toFixed(3)}
                  y1={p.y.toFixed(3)}
                  x2={e.x.toFixed(3)}
                  y2={e.y.toFixed(3)}
                  stroke="#8b949e"
                  strokeWidth={0.04}
                  strokeDasharray="0.2 0.15"
                  opacity={0.7}
                />
              )}
              <rect
                x={(p.x - s).toFixed(3)}
                y={(p.y - s).toFixed(3)}
                width={(s * 2).toFixed(3)}
                height={(s * 2).toFixed(3)}
                fill="transparent"
                stroke="#8b949e"
                strokeWidth={0.05}
                strokeDasharray="0.15 0.1"
              />
              <text x={p.x} y={(p.y + s + 0.3).toFixed(3)} textAnchor="middle" fontSize={0.28} fill="#8b949e">
                {spot.id}
              </text>
            </g>
          );
        })}
      </g>
      <g id="locations">
        {[...groupByZone(site.locations ?? [])].map(([zone, locations]) => {
          const color = zoneColor(zone || undefined);
          return (
            <g key={zone || "unzoned"} id={`zone-${zone || "unzoned"}`}>
              {locations.map((location) =>
                // pick and drop can sit apart; one marker each so the map
                // shows where a robot is actually sent
                stationPoses(location).map(({ kind, pose }) => {
                  const p = toSvg(pose.x, pose.y, bounds);
                  const s = 0.28;
                  return (
                    <g key={`${location.id}-${kind}`} id={`loc-${location.id}-${kind}`}>
                      <polygon
                        points={`${p.x},${(p.y - s).toFixed(3)} ${(p.x + s).toFixed(3)},${p.y} ${p.x},${(p.y + s).toFixed(3)} ${(p.x - s).toFixed(3)},${p.y}`}
                        fill="transparent"
                        stroke={color}
                        strokeWidth={0.06}
                      />
                      <text
                        x={p.x}
                        y={(p.y + s + 0.35).toFixed(3)}
                        textAnchor="middle"
                        fontSize={0.28}
                        fill={color}
                      >
                        {location.name ?? location.id}
                      </text>
                    </g>
                  );
                }),
              )}
            </g>
          );
        })}
      </g>
      <g id="robots">
        {robots.map((r) => {
          if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
          const p = toSvg(r.x, r.y, bounds);
          return (
            <g key={r.serialNumber} id={`robot-${r.serialNumber}`}>
              <circle cx={p.x} cy={p.y} r={0.3} fill="#2f81f7" opacity={0.85} />
              <text x={p.x} y={p.y + 0.75} textAnchor="middle" fontSize={0.3} fill="#e6edf3">
                {r.serialNumber}
              </text>
            </g>
          );
        })}
      </g>
      <g id="waits">
        {waits.flatMap((wait) => {
          const robot = robots.find((r) => r.serialNumber === wait.serialNumber);
          const target = byId.get(wait.nodeId);
          if (!robot || !target || !Number.isFinite(robot.x) || !Number.isFinite(robot.y)) return [];
          const a = toSvg(robot.x, robot.y, bounds);
          const b = toSvg(target.x, target.y, bounds);
          return [
            <line
              key={`wait-${wait.serialNumber}-${wait.nodeId}`}
              x1={a.x.toFixed(3)}
              y1={a.y.toFixed(3)}
              x2={b.x.toFixed(3)}
              y2={b.y.toFixed(3)}
              stroke="#e3b341"
              strokeWidth={0.05}
              strokeDasharray="0.2 0.15"
              opacity={0.9}
            />,
          ];
        })}
      </g>
    </svg>
  );
}
