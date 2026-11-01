import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * THE ACTIVITY FEED — Interactive Mode's core surface.
 *
 * Every tool call, turn and mission transition the MAIN process emits lands here live.
 * It shows what actually ran (name, arguments, real duration, classified outcome) —
 * emitted at the execution choke point in code, so the feed cannot be gamed by prose.
 * Tool cards expand on click to show the full result summary; "While you were away"
 * lists any end-of-task reports that arrived in Background Mode when no toast could.
 */

interface ActivityEvent {
  id: number;
  t: number;
  kind: 'tool' | 'turn' | 'mission' | 'notice';
  status: 'running' | 'ok' | 'failed' | 'blocked' | 'approval' | 'info';
  name: string;
  detail?: string;
  summary?: string;
  ms?: number;
  missionId?: string;
  step?: number;
  steps?: number;
  callId?: string;
}

interface DigestEntry {
  t: number;
  title: string;
  body: string;
  verdict: string;
}

const STATUS_STYLE: Record<ActivityEvent['status'], string> = {
  running: 'text-accent',
  ok: 'text-steel',
  failed: 'text-hot',
  blocked: 'text-hot',
  approval: 'text-accent',
  info: 'text-steel',
};

const STATUS_LABEL: Record<ActivityEvent['status'], string> = {
  running: 'RUN',
  ok: 'OK',
  failed: 'FAIL',
  blocked: 'BLOCKED',
  approval: 'NEEDS YOU',
  info: 'INFO',
};

const time = (t: number): string => new Date(t).toLocaleTimeString('en-GB', { hour12: false });

function Card({ e }: { e: ActivityEvent }) {
  const [open, setOpen] = useState(false);
  const icon =
    e.kind === 'tool' ? '⚙' : e.kind === 'mission' ? '◈' : e.kind === 'notice' ? '✦' : '▸';
  const label =
    e.kind === 'mission'
      ? `MISSION #${e.missionId ?? '?'}${typeof e.step === 'number' && e.steps ? ` · step ${e.step}/${e.steps}` : ''}`
      : e.name;
  const expandable = Boolean(e.summary && e.summary.length > 60);
  return (
    <div
      className={`rounded-lg border border-steel/15 bg-black/30 px-3 py-2 font-mono text-xs ${expandable ? 'cursor-pointer hover:border-steel/35' : ''}`}
      onClick={() => expandable && setOpen((o) => !o)}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-steel/60">{time(e.t)}</span>
        <span aria-hidden>{icon}</span>
        <span className={`truncate ${STATUS_STYLE[e.status]}`}>{label}</span>
        <span className={`ml-auto shrink-0 text-[10px] tracking-wider ${STATUS_STYLE[e.status]}`}>
          {STATUS_LABEL[e.status]}
          {typeof e.ms === 'number' && e.status !== 'running' ? ` · ${e.ms < 1000 ? `${e.ms}ms` : `${(e.ms / 1000).toFixed(1)}s`}` : ''}
        </span>
      </div>
      {e.detail && <div className="mt-1 truncate text-steel/70">{e.detail}</div>}
      {e.summary && (open || !expandable) && (
        <div className="mt-1 whitespace-pre-wrap break-words text-steel/80">{e.summary}</div>
      )}
    </div>
  );
}

export default function ActivityPanel() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [digest, setDigest] = useState<DigestEntry[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    // Late subscriber: pull the ring-buffer history first, then apply live pushes.
    window.electronAPI?.activity?.recent?.(60).then((rows) => {
      const list = (rows as ActivityEvent[]).filter((e) => e && typeof e.id === 'number');
      list.forEach((e) => seen.current.add(e.id));
      setEvents(list);
    }).catch(() => undefined);
    const off = window.electronAPI.on('activity', (raw) => {
      const e = raw as ActivityEvent;
      if (!e || typeof e.id !== 'number' || seen.current.has(e.id)) return;
      seen.current.add(e.id);
      setEvents((prev) => [...prev, e].slice(-200));
    });
    // "While you were away": end-of-task reports recorded while no toast could reach the user.
    window.electronAPI?.notify?.unread?.().then((rows) => {
      const list = (rows as DigestEntry[]).filter((d) => d && typeof d.title === 'string');
      if (list.length) {
        setDigest(list);
        void window.electronAPI.notify.markRead().catch(() => undefined);
      }
    }).catch(() => undefined);
    return off;
  }, []);

  // A finished call replaces its own 'running' card (matched by callId) — the feed shows
  // the real outcome, never a stuck spinner.
  const merged = useMemo(() => {
    const running = new Map<string, number>();
    events.forEach((e, i) => {
      if (e.kind === 'tool' && e.status === 'running' && e.callId) running.set(e.callId, i);
    });
    const kill = new Set<number>();
    events.forEach((e) => {
      if (e.kind === 'tool' && e.status !== 'running' && e.callId && running.has(e.callId)) {
        kill.add(running.get(e.callId)!);
      }
    });
    return events.filter((e, i) => !kill.has(i));
  }, [events]);

  if (!merged.length && !digest.length) return null;
  return (
    <div className="no-drag w-[min(92vw,520px)] rounded-xl border border-steel/20 bg-black/50 backdrop-blur">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[10px] tracking-widest text-steel"
      >
        ACTIVITY · {merged.length}
        <span className="ml-auto">{collapsed ? 'EXPAND' : 'COLLAPSE'}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[46vh] space-y-1.5 overflow-y-auto px-2 pb-2">
          {digest.length > 0 && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
              <div className="font-mono text-[10px] tracking-widest text-accent">WHILE YOU WERE AWAY</div>
              {digest.map((d, i) => (
                <div key={i} className="mt-1 text-xs text-steel">
                  <span className="text-accent">{d.title.replace(/^JARVIS — /, '')}</span> · {d.body}
                </div>
              ))}
            </div>
          )}
          {[...merged].reverse().map((e) => (
            <Card key={e.id} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}
