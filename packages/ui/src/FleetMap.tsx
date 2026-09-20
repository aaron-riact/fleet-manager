import React, { useMemo, useState } from "react";
import type { LockSnapshot, ParkingSpot, Site } from "@fleet-manager/core";
import { boundsOf, gridLines, gridSpacing, groupByZone, headingVector, indexNodes, laneShift, scaleBarLength, stationPoses, toSvg, underlayRect, viewBoxFor, zoneColor } from "./map";

export interface RobotDot {
  serialNumber: string;
  x: number;
  y: number;
  /** World heading in radians; the tick is omitted when unknown. */
  theta?: number;
  /** Carrying a load; drawn as a dashed ring around the dot. */
  laden?: boolean;
  /** Resolved display label of the running action ("PICK…"), if any. */
  actionLabel?: string;
}

/**
 * Host-owned annotations (trolleys, pallets, doors): the map draws them,
 * the host owns what they mean. Rectangles so they never read as robots;
 * without a heading they fall back to squares.
 */
export interface MapMarker {
  id: string;
  x: number;
  y: number;
  label?: string;
  /** Fill; defaults to amber. */
  color?: string;
  /** Long-axis heading in world radians; rotates the rectangle. */
  theta?: number;
  /** Meters; default 1.2 long, 0.8 wide. */
  length?: number;
  width?: number;
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
  markers = [],
}: {
  site: Site;
  robots?: RobotDot[];
  locks?: LockSnapshot;
  parking?: ParkingSpot[];
  /** Robots waiting, each with the node from its own order it waits on. */
  waits?: OrderWait[];
  /** Host-owned annotations; drawn as labelled squares. */
  markers?: MapMarker[];
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

  // Tolerance discs (arrival radii) double as clutter on dense maps.
  const [showTolerance, setShowTolerance] = useState(true);
  // Floor-plan imagery likewise: invaluable for orientation, in the way
  // when tracing exact topology.
  const [showUnderlay, setShowUnderlay] = useState(true);

  return (
    <div style={{ position: "relative" }}>
    <div style={{ position: "absolute", top: "0.5rem", right: "0.5rem", zIndex: 1, display: "flex", gap: "0.4rem" }}>
      <button
        onClick={() => setShowTolerance((v) => !v)}
        aria-pressed={showTolerance}
        title="Toggle node tolerance circles"
        style={{
          width: "2rem",
          height: "2rem",
          borderRadius: "50%",
          border: `1px solid ${showTolerance ? "#2f81f7" : "#232f45"}`,
          background: "rgba(7, 11, 18, 0.7)",
          color: showTolerance ? "#2f81f7" : "#8b98ad",
          fontSize: "1rem",
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ◎
      </button>
      {site.underlay && (
        <button
          onClick={() => setShowUnderlay((v) => !v)}
          aria-pressed={showUnderlay}
          title="Toggle background image"
          style={{
            width: "2rem",
            height: "2rem",
            borderRadius: "50%",
            border: `1px solid ${showUnderlay ? "#2f81f7" : "#232f45"}`,
            background: "rgba(7, 11, 18, 0.7)",
            color: showUnderlay ? "#2f81f7" : "#8b98ad",
            fontSize: "1rem",
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ▦
        </button>
      )}
    </div>
    <svg
      viewBox={viewBoxFor(bounds, 1.5)}
      role="img"
      aria-label={`Map of ${site.name}`}
      style={{ width: "100%", height: "auto", background: "#0b0e14", borderRadius: 12, display: "block" }}
    >
      {site.underlay && underlay && showUnderlay && (
        <image
          href={site.underlay.uri}
          x={underlay.x}
          y={underlay.y}
          width={underlay.width}
          height={underlay.height}
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
        stroke={showUnderlay && underlay ? "#3b4657" : "#8b98ad"}
        strokeWidth={0.05}
        fontSize={0.32}
        fill={showUnderlay && underlay ? "#3b4657" : "#8b98ad"}
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
              const fromNode = byId.get(edge.fromId);
              const toNode = byId.get(edge.toId);
              if (!fromNode || !toNode) return null;
              // Canonical frame (fromId→toId) for the lane: endpoints must
              // NOT swap per leg, or the side flip cancels out and opposing
              // arrows collapse onto one lane tip-to-tip. Only the heading
              // follows the leg's travel direction.
              const forward = leg.from === edge.fromId;
              const a = toSvg(fromNode.x, fromNode.y, bounds);
              const b = toSvg(toNode.x, toNode.y, bounds);
              // Own lane per direction: opposing arrows sit side by side
              // instead of collapsing tip-to-tip into one blob.
              const side = (forward ? 1 : -1) as 1 | -1;
              const { mx, my } = laneShift(a.x, a.y, b.x, b.y, side);
              const base = Math.atan2(b.y - a.y, b.x - a.x);
              const ang = forward ? base : base + Math.PI;
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
          // Light translucent fill: the outline must read against bright
          // map imagery without hiding it. The center dot marks the exact
          // waypoint fix.
          const dot = held ? "#f0883e" : contested ? "#e3b341" : "#e6edf3";
          return (
            <g key={node.id} id={`node-${node.id}`}>
              <title>{node.id}</title>
              {showTolerance && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={node.radius ?? 0.25}
                  fill={held ? "#f0883e22" : "rgba(7, 11, 18, 0.2)"}
                  stroke={held ? "#f0883e" : contested ? "#e3b341" : "#e6edf3"}
                  strokeWidth={0.05}
                  strokeOpacity={held || contested ? undefined : 0.55}
                  strokeDasharray={contested ? "0.15 0.1" : undefined}
                />
              )}
              <circle cx={p.x} cy={p.y} r={0.14} fill={dot} stroke="#0b0e14" strokeWidth={0.03} />
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
                  stroke="#0b0e14"
                  strokeWidth={0.1}
                  opacity={0.7}
                />
              )}
              {e && (
                <line
                  x1={p.x.toFixed(3)}
                  y1={p.y.toFixed(3)}
                  x2={e.x.toFixed(3)}
                  y2={e.y.toFixed(3)}
                  stroke="#e6edf3"
                  strokeWidth={0.04}
                  opacity={0.7}
                />
              )}
              <rect
                x={(p.x - s).toFixed(3)}
                y={(p.y - s).toFixed(3)}
                width={(s * 2).toFixed(3)}
                height={(s * 2).toFixed(3)}
                fill="rgba(7, 11, 18, 0.45)"
                stroke="#0b0e14"
                strokeWidth={0.13}
              />
              <rect
                x={(p.x - s).toFixed(3)}
                y={(p.y - s).toFixed(3)}
                width={(s * 2).toFixed(3)}
                height={(s * 2).toFixed(3)}
                fill="none"
                stroke="#e6edf3"
                strokeWidth={0.05}
              />
              <text
                x={p.x}
                y={(p.y + s + 0.3).toFixed(3)}
                textAnchor="middle"
                fontSize={0.28}
                fill="#e6edf3"
                stroke="#0b0e14"
                strokeWidth={0.06}
                style={{ paintOrder: "stroke" }}
              >
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
                // shows where a robot is actually sent — but a single
                // shared label between them instead of one per marker.
                const posed = stationPoses(location);
                const s = 0.28;
                const labelAt = (() => {
                  const pts = posed.map(({ pose }) => toSvg(pose.x, pose.y, bounds));
                  const mid = pts.reduce(
                    (acc, p) => ({ x: acc.x + p.x / pts.length, y: acc.y + p.y / pts.length }),
                    { x: 0, y: 0 },
                  );
                  return mid;
                })();
                return (
                  <g key={location.id} id={`loc-${location.id}`}>
                    {posed.map(({ kind, pose }) => {
                  const p = toSvg(pose.x, pose.y, bounds);
                  // Pickups point where the robot should look: the pose
                  // theta rotated into SVG space. Drops stay diamonds.
                  // Both get a dark halo copy underneath so zone colors
                  // read on bright imagery.
                  const pickAngle =
                    kind === "pick" && pose.theta !== undefined
                      ? ((-pose.theta * 180) / Math.PI).toFixed(1)
                      : undefined;
                  const diamond = `${p.x},${(p.y - s).toFixed(3)} ${(p.x + s).toFixed(3)},${p.y} ${p.x},${(p.y + s).toFixed(3)} ${(p.x - s).toFixed(3)},${p.y}`;
                  const arrow = `${(p.x + s).toFixed(3)},${p.y} ${(p.x - s * 0.7).toFixed(3)},${(p.y - s * 0.7).toFixed(3)} ${(p.x - s * 0.7).toFixed(3)},${(p.y + s * 0.7).toFixed(3)}`;
                  const marker = (
                    <g>
                      <polygon
                        points={pickAngle !== undefined ? arrow : diamond}
                        transform={
                          pickAngle !== undefined ? `rotate(${pickAngle} ${p.x} ${p.y})` : undefined
                        }
                        fill="none"
                        stroke="#0b0e14"
                        strokeWidth={0.14}
                        opacity={0.9}
                      />
                      <polygon
                        points={pickAngle !== undefined ? arrow : diamond}
                        transform={
                          pickAngle !== undefined ? `rotate(${pickAngle} ${p.x} ${p.y})` : undefined
                        }
                        fill={pickAngle !== undefined ? `${color}33` : "transparent"}
                        stroke={color}
                        strokeWidth={0.06}
                      />
                    </g>
                  );
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
                          {marker}
                        </g>
                      );
                    })}
                    <text
                      x={labelAt.x}
                      y={(labelAt.y + s + 0.35).toFixed(3)}
                      textAnchor="middle"
                      fontSize={0.28}
                      fill={color}
                      stroke="#0b0e14"
                      strokeWidth={0.06}
                      style={{ paintOrder: "stroke" }}
                    >
                      {location.name ?? location.id}
                    </text>
                  </g>
                );
              })}
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
                  stroke="#0b0e14"
                  strokeWidth={0.11}
                  strokeDasharray="0.12 0.1"
                  opacity={0.9}
                />
              )}
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
                  stroke="#0b0e14"
                  strokeWidth={0.12}
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
              <text
                x={p.x}
                y={p.y + 0.75}
                textAnchor="middle"
                fontSize={0.3}
                fill="#e6edf3"
                stroke="#0b0e14"
                strokeWidth={0.06}
                style={{ paintOrder: "stroke" }}
              >
                {r.serialNumber}
              </text>
              {r.actionLabel && (
                <text
                  x={p.x}
                  y={p.y + 1.1}
                  textAnchor="middle"
                  fontSize={0.28}
                  fill="#f0b429"
                  stroke="#0b0e14"
                  strokeWidth={0.06}
                  style={{ paintOrder: "stroke" }}
                >
                  {r.actionLabel}…
                </text>
              )}
            </g>
          );
        })}
      </g>
      <g id="markers">
        {markers.map((m) => {
          if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
          const p = toSvg(m.x, m.y, bounds);
          const color = m.color ?? "#f0b429";
          const length = m.length ?? 1.2;
          const width = m.width ?? 0.8;
          // SVG-space rotation for the world heading (y flips, as in ticks).
          const tilt =
            m.theta !== undefined && Number.isFinite(m.theta)
              ? (() => {
                  const hv = headingVector(m.theta);
                  return (Math.atan2(hv.dy, hv.dx) * 180) / Math.PI;
                })()
              : 0;
          return (
            <g key={m.id} id={`marker-${m.id}`}>
              <rect
                x={(p.x - length / 2).toFixed(3)}
                y={(p.y - width / 2).toFixed(3)}
                width={length}
                height={width}
                transform={`rotate(${tilt.toFixed(1)} ${p.x.toFixed(3)} ${p.y.toFixed(3)})`}
                fill={color}
                fillOpacity={0.25}
                stroke={color}
                strokeWidth={0.06}
              />
              {m.label && (
                <text
                  x={p.x}
                  y={p.y + 0.6}
                  textAnchor="middle"
                  fontSize={0.26}
                  fill={color}
                  stroke="#0b0e14"
                  strokeWidth={0.06}
                  style={{ paintOrder: "stroke" }}
                >
                  {m.label}
                </text>
              )}
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
    </div>
  );
}
