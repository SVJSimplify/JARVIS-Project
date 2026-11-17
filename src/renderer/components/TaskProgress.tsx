import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { useClock } from '../hooks/useClock';
import { useTaskProgress } from '../hooks/useTaskProgress';
import type { AgentProgressView, ProgressSnapshot, ProgressStep, TaskProgressView, TurnProgress } from '../lib/protocol';

/**
 * LIVE TASK PROGRESS — "what is JARVIS doing right now, and where is he in the
 * task list", in real time, in BOTH interaction modes.
 *
 * Three presentations share one body renderer:
 *  - TaskProgress (default): a floating panel that appears on its own while
 *    work runs (turn checklist, durable-task boards) and hides
 *    itself ~12 s after everything goes quiet.
 *  - mini: the one-line pill for the always-on-top mini HUD.
 *  - TaskRailPanel: the persistent right-rail tab with the full board.
 *
 * The data comes from the dedicated `jarvis-progress` channel via
 * useTaskProgress; the background-mode silence contract (feed, speech,
 * notifications) is untouched — this panel is read-only and never talks.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** Compact elapsed: 42s / 12:05 / 1:02:10. Guards garbage clocks. */
export const elapsed = (since: unknown, nowMs: number): string => {
  if (typeof since !== 'number' || !Number.isFinite(since)) return '';
  const s = Math.max(0, Math.floor((nowMs - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

const TURN_GLYPH: Record<ProgressStep['status'], { g: string; cls: string }> = {
  running: { g: '◇', cls: 'animate-pulse text-accent' },
  ok: { g: '✓', cls: 'text-accent' },
  fail: { g: '✗', cls: 'text-hot' },
  held: { g: '◇', cls: 'text-steel' },
};

/** Step glyphs for durable-task lists (their own status vocabularies). */
const boardGlyph = (status: unknown): { g: string; cls: string } => {
  switch (status) {
    case 'running':
      return { g: '●', cls: 'animate-pulse text-accent' };
    case 'done':
    case 'completed':
      return { g: '✓', cls: 'text-accent' };
    case 'failed':
      return { g: '✗', cls: 'text-hot' };
    case 'skipped':
      return { g: '–', cls: 'text-steel' };
    default:
      return { g: '○', cls: 'text-steel' };
  }
};

const isBoardActive = (status: unknown): boolean => status === 'planning' || status === 'running' || status === 'verifying' || status === 'CREATED' || status === 'PLANNING' || status === 'READY' || status === 'VERIFYING' || status === 'WAITING_FOR_INPUT' || status === 'RETRYING';

/** Agent-run glyphs (Round 25): same design language as the task board. */
const agentGlyph = (status: AgentProgressView['status']): { g: string; cls: string } => {
  switch (status) {
    case 'running':
      return { g: '◆', cls: 'animate-pulse text-accent' };
    case 'waiting':
      return { g: '◇', cls: 'animate-pulse text-steel' };
    case 'done':
      return { g: '✓', cls: 'text-accent' };
    case 'failed':
    case 'cancelled':
      return { g: '✗', cls: 'text-hot' };
    default:
      return { g: '◇', cls: 'text-steel' };
  }
};

function Bar({ done, total, failed = 0 }: { done: number; total: number; failed?: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-[3px] flex-1 overflow-hidden bg-line/40">
        <div className={`h-full transition-all duration-500 ${failed > 0 ? 'bg-hot' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[12px] tabular-nums text-steel">
        {done}/{total}
        {failed > 0 && <span className="text-hot"> ✗{failed}</span>}
      </span>
    </div>
  );
}

function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="font-display text-[12px] font-bold text-steel">{children}</h3>
      {right}
    </div>
  );
}

function NowLine({ snap, nowMs }: { snap: ProgressSnapshot; nowMs: number }) {
  if (!snap.now) return null;
  const busy = snap.now.status === 'running';
  return (
    <div className="flex items-baseline gap-2">
      <span className={`font-mono text-[12px] leading-none ${busy ? 'animate-pulse text-accent' : 'text-steel'}`}>{busy ? '▶' : '·'}</span>
      <span className="truncate text-[13px] leading-snug text-hot" title={snap.now.detail || snap.now.label}>
        {snap.now.label}
      </span>
      {busy && <span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums text-steel">{elapsed(snap.now.since, nowMs)}</span>}
    </div>
  );
}

function TurnSection({ turn, nowMs, stepLimit }: { turn: TurnProgress; nowMs: number; stepLimit?: number }) {
  const steps = stepLimit ? turn.steps.slice(-stepLimit) : turn.steps;
  const hidden = turn.steps.length - steps.length;
  const outcome = turn.outcome ?? 'running';
  return (
    <div className="space-y-1.5">
      <SectionTitle
        right={
          <span className={`font-mono text-[12px]   ${outcome === 'running' ? 'animate-pulse text-accent' : outcome === 'fail' || outcome === 'interrupted' ? 'text-hot' : 'text-steel'}`}>
            {outcome === 'running' ? elapsed(turn.startedAt, nowMs) : outcome}
          </span>
        }
      >
        Task
      </SectionTitle>
      <p className="truncate text-[13px] leading-snug text-hot" title={turn.task}>
        {turn.task}
      </p>
      {turn.steps.length > 0 && (
        <>
          <Bar done={turn.done} total={turn.steps.length} failed={turn.failed} />
          <ol className="space-y-1">
            {hidden > 0 && <li className="font-mono text-[12px] text-steel">… {hidden} earlier step(s)</li>}
            {steps.map((s) => {
              const tone = TURN_GLYPH[s.status] ?? TURN_GLYPH.held;
              return (
                <li key={s.key} className="flex items-baseline gap-2">
                  <span className={`w-3 shrink-0 text-center font-mono text-[12px] leading-none ${tone.cls}`}>{tone.g}</span>
                  <span className={`truncate text-[12px] leading-snug ${s.status === 'running' ? 'text-accent' : s.status === 'fail' ? 'text-hot/80' : 'text-steel'}`} title={s.detail || s.label}>
                    {s.label}
                  </span>
                  {s.ms !== undefined && <span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums text-steel/70">{s.ms}ms</span>}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

function TaskSection({ t, compact }: { t: TaskProgressView; compact?: boolean }) {
  const active = isBoardActive(t.status);
  return (
    <div className="space-y-1.5">
      <SectionTitle
        right={
          <span className={`font-mono text-[12px]  ${active ? 'animate-pulse text-accent' : t.status === 'FAILED' || t.status === 'CANCELLED' ? 'text-hot' : 'text-steel'}`}>
            {t.status}
          </span>
        }
      >
        {`Task ${t.id}`}
      </SectionTitle>
      <p className="truncate text-[12px] leading-snug text-hot/90" title={t.objective}>
        {t.objective}
      </p>
      <Bar done={t.done} total={t.total} />
      {!compact && t.steps.length > 0 && (
        <ol className="space-y-1">
          {t.steps.map((s, i) => {
            const tone = boardGlyph(s.status);
            const running = s.status === 'running';
            return (
              <li key={`${i}-${s.title}`} className="flex items-baseline gap-2">
                <span className={`w-3 shrink-0 text-center font-mono text-[12px] leading-none ${tone.cls}`}>{tone.g}</span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-steel/70">{i + 1}.</span>
                <span className={`truncate text-[12px] leading-snug ${running ? 'text-accent' : s.status === 'failed' ? 'text-hot/80' : 'text-steel'}`} title={s.title}>
                  {s.title}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {!compact && t.note && <p className="truncate font-mono text-[12px] text-steel/80" title={t.note}>{t.note}</p>}
    </div>
  );
}

/**
 * Round 25 — AGENTS SECTION: which agents are active, what each is doing and why it was
 * assigned. Meaningful activity summaries by default (running/waiting agents first,
 * then the newest finished runs); the full note is a hover-away, never a terminal dump.
 */
export function AgentsSection({ agents, nowMs, detailed }: { agents: AgentProgressView[]; nowMs: number; detailed?: boolean }) {
  const list = (Array.isArray(agents) ? agents : []).filter((a) => a && typeof a.id === 'string' && typeof a.agent === 'string');
  if (!list.length) return null;
  const active = list.filter((a) => a.status === 'running' || a.status === 'waiting');
  const settled = list.filter((a) => a.status !== 'running' && a.status !== 'waiting');
  const shown = detailed ? list : [...active, ...settled].slice(0, 5);
  return (
    <div className="space-y-1.5">
      <SectionTitle right={<span className="font-mono text-[12px] text-steel">{active.length ? `${active.length} active` : 'idle'}</span>}>
        Agents
      </SectionTitle>
      <ol className="space-y-1">
        {shown.map((a) => {
          const tone = agentGlyph(a.status);
          return (
            <li key={a.id} className="flex items-baseline gap-2">
              <span className={`w-3 shrink-0 text-center font-mono text-[12px] leading-none ${tone.cls}`}>{tone.g}</span>
              <span className={`shrink-0 font-mono text-[12px]   ${a.status === 'running' ? 'text-accent' : 'text-steel/80'}`}>{a.agent}</span>
              <span className={`truncate text-[12px] leading-snug ${a.status === 'running' ? 'text-accent' : a.status === 'failed' || a.status === 'cancelled' ? 'text-hot/80' : 'text-steel'}`} title={a.note || a.why}>
                {a.note || a.why}
              </span>
              {a.status === 'running' && <span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums text-steel/70">{elapsed(a.startedAt, nowMs)}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The full board. Defensive by construction: every collection is re-validated before rendering. */
export function TaskProgressBody({ snap, nowMs, overlay }: { snap: ProgressSnapshot; nowMs: number; overlay?: boolean }) {
  const tasks = (Array.isArray(snap.tasks) ? snap.tasks : []).filter((t) => t && typeof t.id === 'string');
  const turn = snap.turn && typeof snap.turn.task === 'string' ? snap.turn : null;
  const agents = (Array.isArray(snap.agents) ? snap.agents : []) as AgentProgressView[];
  return (
    <div className={`space-y-4 ${overlay ? 'px-4 py-3' : ''}`}>
      {snap.now && <NowLine snap={snap} nowMs={nowMs} />}
      {turn && <TurnSection turn={turn} nowMs={nowMs} stepLimit={overlay ? 6 : undefined} />}
      {agents.length > 0 && <AgentsSection agents={agents} nowMs={nowMs} detailed={!overlay} />}
      {tasks.length > 0 && (
        <div className="space-y-3">
          {(overlay ? tasks.slice(0, 2) : tasks).map((t) => (
            <TaskSection key={t.id} t={t} compact={false} />
          ))}
        </div>
      )}
    </div>
  );
}

/** How long the panel lingers after the last activity before hiding itself. */
const LINGER_MS = 12_000;

export default function TaskProgress({ mini = false }: { mini?: boolean }) {
  const snap = useTaskProgress();
  const now = useClock();
  const lastActive = useRef(0);
  const busy = !!snap?.busy;

  useEffect(() => {
    if (busy) lastActive.current = Date.now();
  }, [busy, snap?.updatedAt]);

  const visible = !!snap && (busy || now.getTime() - lastActive.current < LINGER_MS);
  if (mini) {
    if (!visible) return null;
    const task = (snap?.tasks ?? []).find((t) => isBoardActive(t.status));
    return (
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        className="no-drag pointer-events-none max-w-[94vw] truncate rounded-full border border-accent/40 bg-[#FBF8F2d9] px-4 py-1 font-mono text-[12px] text-accent"
      >
        <span className="mr-2 animate-pulse">▶</span>
        {snap?.now?.label ? `${snap.now.label}` : 'Working'}
        {task && <span className="text-steel">{` · ${task.id} ${task.done}/${task.total}`}</span>}
      </motion.div>
    );
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-20 flex justify-center px-6">
      <AnimatePresence>
        {visible && snap && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="holo-panel no-drag relative z-10 w-full max-w-[560px] overflow-hidden rounded-md"
          >
            <div className="relative z-[3] max-h-[46vh] overflow-y-auto">
              <div className="flex items-center justify-between border-b border-accent/20 px-4 pb-1.5 pt-2.5">
                <h2 className="font-display text-[12px] font-bold text-accent/90">Task Progress</h2>
                <span className="font-mono text-[12px] text-steel">
                  {snap.busy ? <span className="animate-pulse text-accent">● live</span> : 'idle'} · {snap.mode === 'background' ? 'background' : 'interactive'}
                </span>
              </div>
              <TaskProgressBody snap={snap} nowMs={now.getTime()} overlay />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The persistent right-rail view (Tasks tab): always visible, full detail. */
export function TaskRailPanel() {
  const snap = useTaskProgress();
  const now = useClock();
  return (
    <section aria-label="Tasks">
      <h2 className="mb-3 text-[13px] font-semibold text-ink">Tasks</h2>
      {!snap || (!snap.now && !snap.turn && (snap.tasks?.length ?? 0) === 0) ? (
        <div className="rounded-xl border border-dashed border-hairline px-4 py-5 text-center">
          <p className="text-[13px] text-muted">No tasks yet</p>
          <p className="mt-1 text-[12px] leading-5 text-faint">Ask JINI to do something on this computer and its progress shows up here.</p>
        </div>
      ) : (
        <div className="max-h-[430px] overflow-y-auto pr-1">
          <TaskProgressBody snap={snap} nowMs={now.getTime()} />
        </div>
      )}
    </section>
  );
}
