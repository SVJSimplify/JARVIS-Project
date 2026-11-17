import { useState } from 'react';
import { setState, useAppState, type LiveProgress, type TaskView } from '../lib/store';
import { enqueue, fullRefresh } from '../lib/linkClient';
import { Empty, ScreenHeader, ago } from '../components/ui';

// Mirrors the desktop: everything that is not terminal is still in flight (incl. PAUSED).
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const statusText = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export default function TasksScreen() {
  const { tasks, progress, paired, online, lastSync } = useAppState((s) => ({ tasks: s.tasks, progress: s.progress, paired: Boolean(s.link && !s.link.revoked), online: s.connection === 'online', lastSync: s.lastSync }));
  const [busy, setBusy] = useState(false);

  if (!paired) return <Empty title="No desktop paired" hint="Tasks run on your computer. Pair it in Settings to send and follow tasks from here." />;

  const refresh = async () => {
    setBusy(true);
    try {
      await fullRefresh();
    } catch {
      /* the connection status already says offline */
    } finally {
      setBusy(false);
    }
  };

  const active = tasks.filter((t) => !TERMINAL.has(t.status));
  const done = tasks.filter((t) => TERMINAL.has(t.status));

  return (
    <div className="pb-8">
      <ScreenHeader
        title="Tasks"
        action={
          <button className="btn-text pb-1 text-[14px]" disabled={busy || !online} onClick={() => void refresh()}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      <p className="px-1 text-meta text-faint">{online ? 'Live from your desktop' : lastSync ? `Last synced ${ago(lastSync)}` : 'Not synced yet'}</p>

      {online && progress?.turn && <LiveCard p={progress} />}

      {tasks.length === 0 && !progress?.turn && <Empty title="No tasks yet" hint="In Chat, choose Run on desktop and describe what you need done." />}

      {active.length > 0 && (
        <>
          <p className="section-label">In progress</p>
          <ul className="group-list">
            {active.map((t) => (
              <ActiveRow key={t.id} t={t} />
            ))}
          </ul>
        </>
      )}

      {done.length > 0 && (
        <>
          <p className="section-label">Finished</p>
          <ul className="group-list">
            {done.map((t) => (
              <li key={t.id} className="group-row">
                <p className="text-body text-text">{t.objective}</p>
                <p className="mt-1 text-meta text-faint">
                  <span className={t.status === 'COMPLETED' ? 'text-ok' : 'text-danger'}>{statusText(t.status)}</span> · {ago(t.updatedAt)}
                </p>
                {t.note && <p className="mt-1 text-meta text-muted">{t.note}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ActiveRow({ t }: { t: TaskView }) {
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  return (
    <li className="group-row">
      <p className="text-body text-text">{t.objective}</p>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Task progress">
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-meta text-muted">
          {statusText(t.status)} · {t.done} of {t.total} steps
        </span>
        <span className="flex gap-5 text-[14px] font-medium">
          {t.status !== 'PAUSED' && (
            <button className="text-muted active:opacity-70" onClick={() => enqueue('task.pause', { id: t.id })}>
              Pause
            </button>
          )}
          <button
            className="text-danger active:opacity-70"
            onClick={() => {
              // Optimistic: the row reflects the request at once; the desktop's next board push confirms it.
              setState((s) => ({ tasks: s.tasks.map((x) => (x.id === t.id ? { ...x, status: 'CANCELLING', note: 'Stopping…' } : x)) }));
              enqueue('task.cancel', { id: t.id });
            }}
          >
            Cancel
          </button>
        </span>
      </div>
      {t.note && <p className="mt-2 text-meta text-faint">{t.note}</p>}
    </li>
  );
}

const DOT: Record<string, string> = { ok: 'bg-ok', fail: 'bg-danger', running: 'bg-accent animate-pulse', held: 'bg-warn' };

/** What the desktop is doing right now — the same snapshot as its Task Progress rail. */
function LiveCard({ p }: { p: LiveProgress }) {
  const t = p.turn!;
  const running = !t.endedAt;
  return (
    <>
      <p className="section-label">{running ? 'Working now' : 'Last request'}</p>
      <div className="group-list">
        <div className="group-row">
          <div className="flex items-start justify-between gap-3">
            <p className="text-body text-text">{t.task}</p>
            {running && (
              <button className="shrink-0 text-[14px] font-medium text-danger active:opacity-70" onClick={() => enqueue('chat', { text: 'stop', threadId: `stop_${Date.now()}` })}>
                Stop
              </button>
            )}
          </div>
          <p className="mt-1 text-meta text-muted">
            {running ? (p.now?.label ?? 'Thinking…') : t.outcome === 'ok' ? 'Done' : t.outcome === 'interrupted' ? 'Stopped' : 'Failed'} · {t.done} of {t.calls} steps
          </p>
          {t.steps.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {t.steps.slice(-6).map((s, i) => (
                <li key={i} className="flex items-center gap-2.5 text-meta text-muted">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s.status] ?? 'bg-faint'}`} />
                  <span className="truncate">{s.label}</span>
                </li>
              ))}
            </ul>
          )}
          {p.agents.length > 0 && (
            <p className="mt-3 text-meta text-faint">Subagents: {p.agents.map((a) => `${a.name} (${a.status})`).join(', ')}</p>
          )}
        </div>
      </div>
    </>
  );
}
