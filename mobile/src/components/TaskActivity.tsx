import { useEffect, useState } from 'react';
import { useAppState, type ChatMessage, type TaskView } from '../lib/store';

type StepState = NonNullable<TaskView['steps']>[number]['status'];
type Phase = 'queued' | 'sending' | 'planning' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/**
 * Find the durable task the desktop created for this phone request. The task title is written
 * by the desktop model, so match on word overlap (not exact text), newest first.
 */
function matchTask(msg: ChatMessage, tasks: TaskView[]): TaskView | undefined {
  const want = words(msg.text);
  if (!want.size) return undefined;
  let best: { t: TaskView; score: number } | undefined;
  for (const t of tasks) {
    if (t.updatedAt < msg.at - 5_000) continue;
    const have = words(t.objective);
    let hit = 0;
    for (const w of want) if (have.has(w)) hit += 1;
    const score = hit / want.size;
    if (score >= 0.5 && (!best || score > best.score || (score === best.score && t.updatedAt > best.t.updatedAt))) best = { t, score };
  }
  return best?.t;
}

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/**
 * Live activity row for a task sent to the desktop — one compact line (animated state icon,
 * what is happening now, how much is left, elapsed time) that expands into the step list.
 * Every state shown comes from real desktop events; nothing animates without work behind it.
 */
export default function TaskActivity({ msg, reply }: { msg: ChatMessage; reply?: ChatMessage }) {
  const tasks = useAppState((s) => s.tasks);
  const task = matchTask(msg, tasks);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  const phase: Phase =
    msg.state === 'queued'
      ? 'queued'
      : msg.state === 'sending'
        ? 'sending'
        : task
          ? task.status === 'COMPLETED'
            ? 'done'
            : task.status === 'FAILED'
              ? 'failed'
              : task.status === 'CANCELLED'
                ? 'cancelled'
                : task.status === 'PAUSED'
                  ? 'paused'
                  : 'running'
          : reply?.state === 'failed'
            ? 'failed'
            : reply?.state === 'done' && now - reply.at > 2_500 // the task event may trail the reply slightly
              ? 'done'
              : 'planning';

  const live = phase === 'sending' || phase === 'planning' || phase === 'running';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const end = task && TERMINAL.has(task.status) ? task.updatedAt : reply && !task && reply.state !== 'running' ? reply.at : now;
  const elapsed = fmtElapsed(end - msg.at);

  const steps = task?.steps ?? [];
  const current = steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'pending');
  const doneCount = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const remaining = steps.length - doneCount - (current ? 1 : 0);

  const headline =
    phase === 'queued'
      ? 'Waiting for your desktop'
      : phase === 'sending'
        ? 'Sending to your desktop'
        : phase === 'planning'
          ? 'Planning the work'
          : phase === 'running'
            ? current?.title ?? 'Working'
            : phase === 'paused'
              ? 'Paused'
              : phase === 'done'
                ? steps.length
                  ? `Completed ${steps.length} step${steps.length === 1 ? '' : 's'}`
                  : 'Done'
                : phase === 'cancelled'
                  ? 'Cancelled'
                  : 'Could not finish';
  const detail =
    phase === 'running' && steps.length
      ? remaining > 0
        ? `and ${remaining} more step${remaining === 1 ? '' : 's'}`
        : `step ${doneCount + 1} of ${steps.length}`
      : '';

  const canExpand = steps.length > 0 || Boolean(task?.note);

  return (
    <div className="anim-enter max-w-[92%]">
      <button
        type="button"
        onClick={() => canExpand && setOpen((o) => !o)}
        aria-expanded={canExpand ? open : undefined}
        className="group flex w-full items-center gap-2.5 py-1 text-left"
      >
        <PhaseIcon phase={phase} />
        <span className="min-w-0 flex-1 truncate text-[14px]">
          <span className={phase === 'failed' ? 'text-danger' : phase === 'done' ? 'text-text' : 'text-text'}>{headline}</span>
          {detail && <span className="text-muted"> {detail}</span>}
        </span>
        {phase !== 'queued' && <span className="shrink-0 text-meta tabular-nums text-faint">{elapsed}</span>}
        {canExpand && (
          <svg viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 text-faint transition-transform duration-200 ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        )}
      </button>

      {phase === 'running' && steps.length > 0 && (
        <div className="ml-[30px] mt-1.5 h-[3px] overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <div className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${Math.max(4, Math.round((doneCount / steps.length) * 100))}%` }} />
        </div>
      )}

      <div className="expand" data-open={open && canExpand}>
        <div>
          <ol className="ml-[9px] mt-2 border-l border-hairline pl-[20px]">
            {steps.map((s, i) => (
              <li key={`${i}-${s.title}`} className="anim-enter flex items-start gap-2.5 py-1.5" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <StepIcon state={s.status} />
                <span className={`text-[13.5px] leading-5 ${s.status === 'running' ? 'text-text' : s.status === 'failed' ? 'text-danger' : s.status === 'pending' ? 'text-faint' : 'text-muted'}`}>{s.title}</span>
              </li>
            ))}
            {task?.note && <li className="py-1.5 text-meta text-faint">{task.note}</li>}
          </ol>
        </div>
      </div>

      {reply?.text && (phase === 'done' || phase === 'failed' || !task) && reply.state !== 'running' && (
        <p className={`anim-enter mt-2 whitespace-pre-wrap text-body ${reply.state === 'failed' ? 'text-danger' : 'text-text'}`}>{reply.text}</p>
      )}
      {reply?.image && reply.state === 'done' && <img src={reply.image} alt="Screenshot from your desktop" className="anim-enter mt-2 w-full rounded-xl border border-hairline" />}
    </div>
  );
}

function PhaseIcon({ phase }: { phase: Phase }) {
  const box = 'flex h-5 w-5 shrink-0 items-center justify-center';
  if (phase === 'sending' || phase === 'planning' || phase === 'running') {
    return (
      <span className={box} aria-label="In progress" role="img">
        <svg viewBox="0 0 20 20" className="anim-spin h-[18px] w-[18px]" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" stroke="#E6DECF" strokeWidth="2" />
          <path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" stroke="#B05A33" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (phase === 'done') {
    return (
      <span className={`${box} rounded-full bg-accent`} aria-label="Completed" role="img">
        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="#FFFDF9" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path className="anim-draw" d="m5 10.5 3.2 3.2L15 6.8" />
        </svg>
      </span>
    );
  }
  if (phase === 'failed' || phase === 'cancelled') {
    return (
      <span className={`${box} rounded-full ${phase === 'failed' ? 'bg-danger/15 text-danger' : 'bg-surface-2 text-faint'}`} aria-label={phase} role="img">
        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l8 8M14 6l-8 8" />
        </svg>
      </span>
    );
  }
  if (phase === 'paused') {
    return (
      <span className={`${box} text-warn`} aria-label="Paused" role="img">
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
          <rect x="5" y="4" width="3.2" height="12" rx="1" />
          <rect x="11.8" y="4" width="3.2" height="12" rx="1" />
        </svg>
      </span>
    );
  }
  // queued: waiting quietly for the desktop
  return (
    <span className={`${box} anim-pulse`} aria-label="Waiting" role="img">
      <span className="h-2 w-2 rounded-full border-[1.5px] border-faint" />
    </span>
  );
}

function StepIcon({ state }: { state: StepState }) {
  const box = 'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center';
  if (state === 'running') {
    return (
      <span className={box}>
        <svg viewBox="0 0 20 20" className="anim-spin h-3.5 w-3.5" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7" stroke="#E6DECF" strokeWidth="2.4" />
          <path d="M10 3a7 7 0 0 1 7 7" stroke="#B05A33" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (state === 'done' || state === 'skipped') {
    return (
      <span className={`${box} text-accent`}>
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path className="anim-draw" d="m4.5 10.5 3.5 3.5 7.5-8" />
        </svg>
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className={`${box} text-danger`}>
        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l8 8M14 6l-8 8" />
        </svg>
      </span>
    );
  }
  return (
    <span className={box}>
      <span className="h-1.5 w-1.5 rounded-full bg-faint" />
    </span>
  );
}
