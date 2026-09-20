import React, { useMemo } from "react";
import type { LockSnapshot, ParkingSpot, Site } from "@fleet-manager/core";
import { boundsOf, gridLines, gridSpacing, groupByZone, headingVector, indexNodes, scaleBarLength, stationPoses, toSvg, underlayRect, viewBoxFor, zoneColor } from "./map";

export interface RobotDot {
  serialNumber: string;
  x: number;
  y: number;
  /** World heading in radians; the tick is omitted when unknown. */
  theta?: number;
  /** Carrying a load; drawn as a dashed ring around the dot. */
  laden?: boolean;
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
  const underlay = useMemo(
    () => (site.underlay ? underlayRect(site.underlay, bounds) : undefined),
    [site, bounds],
  );
  const grid = useMemo(() => {
    const w = Math.max(bounds.maxX - bounds.minX, 1);
    const h = Math.max(bounds.maxY - bounds.minY, 1);
    const spacing = gridSpacing(w);
    return { w, h, spacing, ...gridLines(bounds, spacing), bar: scaleBarLength(w) };
  }, [bounds]);
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
      {site.underlay && underlay && (
        <image
          href={site.underlay.uri}
          x={underlay.x}
          y={underlay.y}
          width={underlay.width}
          height={underlay.height}
          opacity={0.55}
          preserveAspectRatio="none"
        />
      )}
      <g id="grid" stroke="#232f45" strokeWidth={0.03} opacity={0.9}>
        {grid.vertical.map((x) => {
          const a = toSvg(x, bounds.minY, bounds);
          const b = toSvg(x, bounds.maxY, bounds);
          return <line key={`gv${x}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
        {grid.horizontal.map((y) => {
          const a = toSvg(bounds.minX, y, bounds);
          const b = toSvg(bounds.maxX, y, bounds);
          return <line key={`gh${y}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
      <g
        id="scalebar"
        stroke="#8b98ad"
        strokeWidth={0.05}
        fontSize={0.32}
        fill="#8b98ad"
      >
        <line x1={0.35} y1={grid.h - 0.35} x2={0.35 + grid.bar} y2={grid.h - 0.35} />
        <line x1={0.35} y1={grid.h - 0.47} x2={0.35} y2={grid.h - 0.23} />
        <line x1={0.35 + grid.bar} y1={grid.h - 0.47} x2={0.35 + grid.bar} y2={grid.h - 0.23} />
        <text x={0.35 + grid.bar / 2} y={grid.h - 0.55} textAnchor="middle" stroke="none">
          {grid.bar} m
        </text>
        {/* North is +Y by the site convention (meters, y-up plans). */}
        <line x1={grid.w - 0.35} y1={1.3} x2={grid.w - 0.35} y2={0.6} />
        <polygon
          points={`${grid.w - 0.35},0.35 ${grid.w - 0.53},0.75 ${grid.w - 0.17},0.75`}
          stroke="none"
          fill="#8b98ad"
        />
        <text x={grid.w - 0.35} y={1.65} textAnchor="middle" stroke="none">
          N
        </text>
      </g>
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
          // Translucent dark fill: the light outline must read against
          // bright map imagery, while the image still shows through.
          // The center dot marks the exact waypoint fix.
          const dot = held ? "#f0883e" : contested ? "#e3b341" : "#e6edf3";
          return (
            <g key={node.id} id={`node-${node.id}`}>
              <title>{node.id}</title>
              <circle
                cx={p.x}
                cy={p.y}
                r={node.radius ?? 0.25}
                fill={held ? "#f0883e22" : "rgba(7, 11, 18, 0.45)"}
                stroke={held ? "#f0883e" : contested ? "#e3b341" : "#e6edf3"}
                strokeWidth={0.06}
                strokeDasharray={contested ? "0.15 0.1" : undefined}
              />
              <circle cx={p.x} cy={p.y} r={0.07} fill={dot} />
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
              {locations.map((location) => {
                const entry = location.entry ? byId.get(location.entry) : undefined;
                const entrySvg = entry ? toSvg(entry.x, entry.y, bounds) : undefined;
                // pick and drop can sit apart; one marker each so the map
                // shows where a robot is actually sent
                return stationPoses(location).map(({ kind, pose }) => {
                  const p = toSvg(pose.x, pose.y, bounds);
                  const s = 0.28;
                  return (
                    <g key={`${location.id}-${kind}`} id={`loc-${location.id}-${kind}`}>
                      {entrySvg && kind === "drop" && (
                        <line
                          x1={p.x.toFixed(3)}
                          y1={p.y.toFixed(3)}
                          x2={entrySvg.x.toFixed(3)}
                          y2={entrySvg.y.toFixed(3)}
                          stroke={color}
                          strokeWidth={0.04}
                          opacity={0.7}
                        />
                      )}
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
                })}
              )}
            </g>
          );
        })}
      </g>
      <g id="robots">
        {robots.map((r) => {
          if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
          const p = toSvg(r.x, r.y, bounds);
          const tick = r.theta !== undefined && Number.isFinite(r.theta) ? headingVector(r.theta) : undefined;
          const tickLen = 0.55;
          return (
            <g key={r.serialNumber} id={`robot-${r.serialNumber}`}>
              <circle cx={p.x} cy={p.y} r={0.3} fill="#2f81f7" opacity={0.85} />
              <circle cx={p.x} cy={p.y} r={0.3} fill="none" stroke="#2f81f7" strokeWidth={0.05} opacity={0.5}>
                <animate attributeName="r" values="0.3;0.9" dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.5;0" dur="2s" repeatCount="indefinite" />
              </circle>
              {r.laden && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={0.45}
                  fill="none"
                  stroke="#e6edf3"
                  strokeWidth={0.05}
                  strokeDasharray="0.12 0.1"
                  opacity={0.9}
                />
              )}
              {tick && (
                <line
                  x1={p.x}
                  y1={p.y}
                  x2={(p.x + tick.dx * tickLen).toFixed(3)}
                  y2={(p.y + tick.dy * tickLen).toFixed(3)}
                  stroke="#e6edf3"
                  strokeWidth={0.06}
                  opacity={0.9}
                />
              )}
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
