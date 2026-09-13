import React, { useMemo } from "react";
import type { LockSnapshot, Site } from "@fleet-manager/core";
import { boundsOf, indexNodes, toSvg, viewBoxFor } from "./map";

export interface RobotDot {
  serialNumber: string;
  x: number;
  y: number;
}

/** Graph overlay: edges under nodes, positions in meters. */
export function FleetMap({
  site,
  robots = [],
  locks,
}: {
  site: Site;
  robots?: RobotDot[];
  locks?: LockSnapshot;
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
    </svg>
  );
}
