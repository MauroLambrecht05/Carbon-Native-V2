import { useEffect, useRef, useState, useCallback } from "react";
import { useApp } from "@/lib/store";
import { tracePath } from "@/lib/types";
import type { SemanticEntity, SemanticRelationship } from "@/lib/types";

// Pure SVG graph renderer — no external graph library required.
// Renders a force-directed layout via a simple spring simulation.

interface Node {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
}

interface Edge {
  from: string;
  to: string;
  label: string;
}

const TYPE_COLOR: Record<string, string> = {
  PRODUCT:       "#60a5fa",
  SOLUTION:      "#818cf8",
  CAPABILITY:    "#4ade80",
  CONTRACT:      "#c084fc",
  INFRASTRUCTURE:"#86efac",
  INTEGRATION:   "#f87171",
  EXTERNAL_SYSTEM:"#fca5a5",
  TECHNOLOGY:    "#67e8f9",
  BUILD:         "#fcd34d",
  CI_PIPELINE:   "#fbbf24",
  CONFIGURATION: "#a78bfa",
  FEATURE_FLAG:  "#c4b5fd",
  BOUNDARY:      "#f0abfc",
  SYSTEM:        "#93c5fd",
  default:       "#7a8499",
};

function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? TYPE_COLOR.default;
}

const RADIUS = 24;
const WIDTH  = 900;
const HEIGHT = 650;

function initNodes(entities: SemanticEntity[]): Node[] {
  return entities.map((e, i) => {
    const angle = (i / entities.length) * 2 * Math.PI;
    const r = Math.min(WIDTH, HEIGHT) * 0.35;
    return {
      id:    e.id,
      label: e.shortName ?? e.name.slice(0, 20),
      type:  e.type,
      x:     WIDTH  / 2 + r * Math.cos(angle),
      y:     HEIGHT / 2 + r * Math.sin(angle),
      vx: 0, vy: 0,
    };
  });
}

function runLayout(nodes: Node[], edges: Edge[], iterations = 100): Node[] {
  const ns = nodes.map(n => ({ ...n }));
  const nodeMap = new Map(ns.map(n => [n.id, n]));

  const K    = 80;   // spring rest length
  const KR   = 4000; // repulsion
  const DAMP = 0.85;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i]!;
        const b = ns[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const force = KR / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Attraction
    for (const e of edges) {
      const a = nodeMap.get(e.from);
      const b = nodeMap.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
      const force = (dist - K) * 0.05;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Center gravity
    for (const n of ns) {
      if (n.pinned) continue;
      n.vx += (WIDTH  / 2 - n.x) * 0.002;
      n.vy += (HEIGHT / 2 - n.y) * 0.002;
      n.vx *= DAMP;
      n.vy *= DAMP;
      n.x = Math.max(RADIUS + 4, Math.min(WIDTH  - RADIUS - 4, n.x + n.vx));
      n.y = Math.max(RADIUS + 4, Math.min(HEIGHT - RADIUS - 4, n.y + n.vy));
    }
  }
  return ns;
}

export default function GraphView() {
  const { state, dispatch } = useApp();
  const { model, indexes, focusEntityId, selectedEntityId, traceFrom, traceTo } = state;

  const svgRef  = useRef<SVGSVGElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan]   = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ nodeId: string; ox: number; oy: number } | null>(null);
  const [isPanning, setIsPanning] = useState<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [maxNodes, setMaxNodes] = useState(60);

  // Focus-mode: show only the entity and its immediate neighbors
  const visibleEntities = (() => {
    if (!model || !indexes) return [];
    const all = model.entities;

    if (focusEntityId) {
      const neighbors = new Set<string>([focusEntityId]);
      const outRels = indexes.relsByFrom.get(focusEntityId) ?? [];
      const inRels  = indexes.relsByTo.get(focusEntityId) ?? [];
      for (const r of [...outRels, ...inRels]) {
        neighbors.add(r.from);
        neighbors.add(r.to);
      }
      return all.filter(e => neighbors.has(e.id)).slice(0, maxNodes);
    }

    // Default: show top entities by relationship count
    const relCount = new Map<string, number>();
    for (const r of model.relationships) {
      relCount.set(r.from, (relCount.get(r.from) ?? 0) + 1);
      relCount.set(r.to,   (relCount.get(r.to)   ?? 0) + 1);
    }
    return all
      .filter(e => !["RULE","CHECK","VALIDATION","ERROR","PROCESS","DATA"].includes(e.type))
      .sort((a, b) => (relCount.get(b.id) ?? 0) - (relCount.get(a.id) ?? 0))
      .slice(0, maxNodes);
  })();

  const visibleIds = new Set(visibleEntities.map(e => e.id));

  const visibleRels = (model?.relationships ?? []).filter(
    r => visibleIds.has(r.from) && visibleIds.has(r.to) && r.relationship !== "CONTAINS"
  );

  // Trace path highlight
  const tracePath_result = (() => {
    if (!traceFrom || !traceTo || !indexes) return new Set<string>();
    const path = tracePath(traceFrom, traceTo, indexes);
    return path ? new Set(path) : new Set<string>();
  })();

  // (Re)layout when entities change
  useEffect(() => {
    if (visibleEntities.length === 0) return;
    const initN = initNodes(visibleEntities);
    const edgeList = visibleRels.slice(0, 200).map(r => ({
      from: r.from, to: r.to, label: r.relationship,
    }));
    const laid = runLayout(initN, edgeList, 120);
    setNodes(laid);
    setEdges(edgeList);
  }, [visibleEntities.length, focusEntityId, maxNodes]);  // Mouse drag for nodes and pan
  const onNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    setDragging({ nodeId, ox: e.clientX, oy: e.clientY });
  }, []);

  const onSvgMouseDown = useCallback((e: React.MouseEvent) => {
    if (dragging) return;
    setIsPanning({ startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y });
  }, [pan, dragging]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      const dx = (e.clientX - dragging.ox) / zoom;
      const dy = (e.clientY - dragging.oy) / zoom;
      setNodes(ns => ns.map(n =>
        n.id === dragging.nodeId
          ? { ...n, x: n.x + dx, y: n.y + dy, vx: 0, vy: 0, pinned: true }
          : n
      ));
      setDragging(d => d ? { ...d, ox: e.clientX, oy: e.clientY } : null);
    } else if (isPanning) {
      setPan({
        x: isPanning.panX + (e.clientX - isPanning.startX),
        y: isPanning.panY + (e.clientY - isPanning.startY),
      });
    }
  }, [dragging, isPanning, zoom]);

  const onMouseUp = useCallback(() => {
    setDragging(null);
    setIsPanning(null);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.max(0.2, Math.min(3, z - e.deltaY * 0.001)));
  }, []);

  if (!model) return null;

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Toolbar */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="text-muted text-small">{visibleEntities.length} nodes · {visibleRels.length} edges</span>
        <button className="btn text-small" onClick={() => dispatch({ type: "SET_FOCUS", id: null })}>
          {focusEntityId ? "← Show all" : "All entities"}
        </button>
        <select
          value={maxNodes}
          onChange={e => setMaxNodes(Number(e.target.value))}
          style={{ width: 120, fontSize: 12 }}
        >
          <option value={30}>30 nodes</option>
          <option value={60}>60 nodes</option>
          <option value={100}>100 nodes</option>
          <option value={200}>200 nodes</option>
        </select>
        <button className="btn text-small" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Reset view</button>
        <button className="btn text-small" onClick={() => setZoom(z => Math.min(3, z + 0.2))}>+</button>
        <button className="btn text-small" onClick={() => setZoom(z => Math.max(0.2, z - 0.2))}>-</button>
        {focusEntityId && (
          <span style={{ fontSize: 12, color: "var(--accent)" }}>
            Focus: {indexes?.byId.get(focusEntityId)?.name}
          </span>
        )}
        {traceFrom && traceTo && (
          <span style={{ fontSize: 12, color: "var(--green)" }}>
            Trace: {tracePath_result.size} nodes highlighted
          </span>
        )}
      </div>

      {/* SVG canvas */}
      <div className="graph-container" style={{ flex: 1 }}>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={{ cursor: isPanning ? "grabbing" : "grab" }}
          onMouseDown={onSvgMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
        >
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="var(--border)" />
            </marker>
          </defs>

          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>

            {/* Edges */}
            {edges.map((edge, i) => {
              const a = nodeMap.get(edge.from);
              const b = nodeMap.get(edge.to);
              if (!a || !b) return null;

              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
              const ex = a.x + (dx / dist) * RADIUS;
              const ey = a.y + (dy / dist) * RADIUS;
              const tx = b.x - (dx / dist) * (RADIUS + 10);
              const ty = b.y - (dy / dist) * (RADIUS + 10);

              const inTrace = tracePath_result.size > 0 &&
                tracePath_result.has(edge.from) && tracePath_result.has(edge.to);
              const isHovered = hovered === edge.from || hovered === edge.to;

              return (
                <g key={i}>
                  <line
                    x1={ex} y1={ey} x2={tx} y2={ty}
                    stroke={inTrace ? "var(--green)" : isHovered ? "var(--accent)" : "var(--border)"}
                    strokeWidth={inTrace ? 2.5 : isHovered ? 1.5 : 1}
                    markerEnd="url(#arrow)"
                    opacity={isHovered || inTrace ? 1 : 0.5}
                  />
                  {isHovered && (
                    <text
                      x={(ex + tx) / 2} y={(ey + ty) / 2 - 4}
                      textAnchor="middle"
                      fontSize={9}
                      fill="var(--text-muted)"
                      fontFamily="var(--font)"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map(node => {
              const isSelected  = selectedEntityId === node.id;
              const isFocused   = focusEntityId === node.id;
              const inTrace     = tracePath_result.has(node.id);
              const color       = typeColor(node.type);
              const strokeColor = isSelected ? "var(--accent)"
                                : isFocused   ? "var(--yellow)"
                                : inTrace     ? "var(--green)"
                                : hovered === node.id ? "var(--text-dim)"
                                : "rgba(255,255,255,0.1)";

              return (
                <g
                  key={node.id}
                  className="graph-node"
                  transform={`translate(${node.x},${node.y})`}
                  onMouseDown={e => onNodeMouseDown(e, node.id)}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => dispatch({ type: "SELECT_ENTITY", id: node.id })}
                >
                  <circle
                    r={RADIUS}
                    fill={`${color}22`}
                    stroke={strokeColor}
                    strokeWidth={isSelected || isFocused ? 2.5 : 1.5}
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={9}
                    fill={color}
                    fontFamily="var(--font)"
                    fontWeight={isSelected ? "700" : "500"}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {node.label.length > 14
                      ? node.label.slice(0, 6) + "…" + node.label.slice(-6)
                      : node.label}
                  </text>
                  {isFocused && (
                    <circle r={RADIUS + 4} fill="none" stroke="var(--yellow)" strokeWidth={1} strokeDasharray="4 3" opacity={0.6} />
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Legend */}
      <div style={{ padding: "6px 16px", borderTop: "1px solid var(--border)", display: "flex", gap: 16, flexWrap: "wrap" }}>
        {["PRODUCT","CAPABILITY","CONTRACT","INFRASTRUCTURE","INTEGRATION","TECHNOLOGY","BUILD"].map(t => (
          <div key={t} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-muted)" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: typeColor(t), opacity: 0.7 }} />
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}
