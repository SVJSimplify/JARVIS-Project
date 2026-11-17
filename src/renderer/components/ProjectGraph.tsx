import { useMemo } from 'react';

/**
 * PROJECT GRAPH (Round 22) — the project dependency graph as a dependency-free SVG.
 * Nodes are milestones (group headers) and tasks; edges are `dependsOn` relations.
 * Layout: longest-path layering (every task sits one layer below its deepest dependency)
 * so arrows always point downward. Pure rendering — every state shown comes from the
 * durable project record passed by ProjectsPanel.
 */

export interface GraphTask {
  id: string;
  title: string;
  state: string;
  dependsOn: string[];
  milestoneId: string;
}

interface Props {
  tasks: GraphTask[];
  milestones: Array<{ id: string; title: string }>;
  onOpenTask?: (id: string) => void;
}

const NODE_W = 168;
const NODE_H = 44;
const GAP_X = 24;
const GAP_Y = 74;
const MARGIN = 16;

const stateColor = (state: string): string =>
  state === 'completed'
    ? '#35d0a0'
    : state === 'running'
      ? '#7fe9ff'
      : state === 'blocked'
        ? '#ff5f7a'
        : state === 'failed'
          ? '#ff8a5f'
          : state === 'interrupted'
            ? '#e9c46a'
            : state === 'skipped'
              ? '#5b6b7d'
              : '#46586c';

const stateBg = (state: string): string =>
  state === 'completed' ? 'rgba(53,208,160,0.10)' : state === 'running' ? 'rgba(127,233,255,0.10)' : state === 'blocked' ? 'rgba(255,95,122,0.10)' : 'rgba(127,233,255,0.03)';

export default function ProjectGraph({ tasks, milestones, onOpenTask }: Props) {
  const layout = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // Longest-path layer: layer(t) = 0 without deps, else max(layer(dep)) + 1 (cycle-safe).
    const layer = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (id: string, guard = 0): number => {
      if (layer.has(id)) return layer.get(id)!;
      if (visiting.has(id) || guard > tasks.length + 1) return 0;
      visiting.add(id);
      const t = byId.get(id);
      const d = t && t.dependsOn.length ? Math.max(...t.dependsOn.map((dep) => (byId.has(dep) ? depthOf(dep, guard + 1) + 1 : 0))) : 0;
      visiting.delete(id);
      layer.set(id, d);
      return d;
    };
    tasks.forEach((t) => depthOf(t.id));
    const maxLayer = Math.max(0, ...tasks.map((t) => layer.get(t.id) ?? 0));
    const columns: GraphTask[][] = Array.from({ length: maxLayer + 1 }, () => []);
    for (const t of tasks) (columns[layer.get(t.id) ?? 0] ?? columns[0]).push(t);
    const positions = new Map<string, { x: number; y: number }>();
    let widest = 1;
    columns.forEach((col, li) => {
      widest = Math.max(widest, col.length);
      col.forEach((t, i) => positions.set(t.id, { x: MARGIN + li * (NODE_W + GAP_X), y: MARGIN + 34 + i * (NODE_H + GAP_Y) }));
    });
    const width = MARGIN * 2 + maxLayer * (NODE_W + GAP_X) + NODE_W;
    const height = MARGIN * 2 + 34 + widest * (NODE_H + GAP_Y) - GAP_Y;
    return { positions, columns, width: Math.max(width, 320), height: Math.max(height, 160) };
  }, [tasks]);

  const edges: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; key: string }> = [];
  for (const t of tasks) {
    const to = layout.positions.get(t.id);
    if (!to) continue;
    for (const dep of t.dependsOn) {
      const from = layout.positions.get(dep);
      if (from) edges.push({ from, to, key: `${dep}->${t.id}` });
    }
  }

  const milestoneOf = (id: string): string => milestones.find((m) => m.id === id)?.title ?? id;

  return (
    <div className="overflow-auto rounded-sm border border-line bg-[rgb(var(--accent)/0.02)]">
      <svg width={layout.width} height={layout.height} role="img" aria-label="Project dependency graph">
        {milestones.map((m, i) => (
          <text key={m.id} x={MARGIN + i * 2} y={20} fontSize="10" fill="rgba(127,233,255,0.75)" className="font-mono" letterSpacing="1.5">
            {`${m.id} · ${m.title}`.toUpperCase().slice(0, 46)}
          </text>
        ))}
        {edges.map((e) => {
          const x1 = e.from.x + NODE_W;
          const y1 = e.from.y + NODE_H / 2;
          const x2 = e.to.x;
          const y2 = e.to.y + NODE_H / 2;
          const midX = (x1 + x2) / 2;
          return (
            <path
              key={e.key}
              d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="rgba(127,233,255,0.35)"
              strokeWidth="1.4"
              markerEnd="url(#pg-arrow)"
            />
          );
        })}
        <defs>
          <marker id="pg-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="rgba(127,233,255,0.55)" />
          </marker>
        </defs>
        {tasks.map((t) => {
          const p = layout.positions.get(t.id);
          if (!p) return null;
          const clickable = typeof onOpenTask === 'function';
          return (
            <g
              key={t.id}
              transform={`translate(${p.x}, ${p.y})`}
              onClick={clickable ? () => onOpenTask(t.id) : undefined}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <rect width={NODE_W} height={NODE_H} rx="5" fill={stateBg(t.state)} stroke={stateColor(t.state)} strokeOpacity="0.55" />
              <rect width="4" height={NODE_H} rx="2" fill={stateColor(t.state)} />
              <text x="12" y="18" fontSize="11.5" fill="#dbe9f4" className="font-display">
                {t.title.length > 24 ? `${t.title.slice(0, 23)}…` : t.title}
              </text>
              <text x="12" y="33" fontSize="9" fill="rgba(123,146,166,0.9)" className="font-mono" letterSpacing="0.6">
                {`${t.id} · ${milestoneOf(t.milestoneId)} · ${t.state.toUpperCase()}`.slice(0, 38)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
