import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Battery, HudAlert, Telemetry } from '../hooks/useTelemetry';
import SystemPanel from './SystemPanel';
import { TaskRailPanel } from './TaskProgress';
import { useClock } from '../hooks/useClock';
import { MODE_LABEL, type JarvisMode } from '../lib/jarvisMode';
import type { InteractionMode } from '../lib/protocol';
import LevelMeter from './LevelMeter';

const SESSION_START = Date.now();
const pad = (n: number) => String(n).padStart(2, '0');
const hms = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

interface StatusProps {
  mode: JarvisMode;
  levelRef: MutableRefObject<number>;
  /** Real whisper engine state, from useVoiceAgent. */
  voiceReady: boolean;
  /** How JARVIS presents his work: live feed or silent background. */
  imode: InteractionMode;
}

export function StatusPanel({ mode, levelRef, voiceReady, imode }: StatusProps) {
  const now = useClock();
  const up = Math.floor((now.getTime() - SESSION_START) / 1000);
  const uptime = `${pad(Math.floor(up / 3600))}:${pad(Math.floor((up % 3600) / 60))}:${pad(up % 60)}`;

  return (
    <aside className="rail w-60">
      <h2 className="rail-title">Status</h2>
      <div className="font-mono text-[34px] leading-none tabular-nums text-hot">
        {hms(now).slice(0, 5)}
        <span className="text-accent/70">{hms(now).slice(5)}</span>
      </div>
      <div className="mt-1 text-sm text-steel">
        {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>
      <dl className="readout mt-8">
        <div>
          <dt>State</dt>
          <dd className="text-accent">{MODE_LABEL[mode]}</dd>
        </div>
        <div>
          <dt>Feed</dt>
          <dd className={imode === 'background' ? 'text-steel' : 'text-accent'}>
            {imode === 'background' ? 'Background — silent' : 'Interactive — live'}
          </dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{uptime}</dd>
        </div>
        <div>
          <dt>Voice engine</dt>
          <dd>{voiceReady ? 'Ready' : 'Loading…'}</dd>
        </div>
        <div>
          <dt>Input level</dt>
          <dd>
            <LevelMeter levelRef={levelRef} />
          </dd>
        </div>
      </dl>
    </aside>
  );
}

/**
 * The in-session transcript renderer: what the user asked and what JARVIS replied, as
 * it happened. Round 23: this lives in Settings → Transcript now (the top-right rail
 * keeps only the live task board); the component is reused there — one implementation.
 */
export function CommandLog({ log }: { log: LogEntry[] }) {
  return (
    <div className="space-y-4">
      {log.length === 0 ? (
        <p className="text-sm text-steel">Nothing heard yet.</p>
      ) : (
        <ol className="space-y-4">
          <AnimatePresence initial={false}>
            {log.map((e) => (
              <motion.li
                key={e.id}
                layout
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.35 }}
              >
                <time className="font-mono text-xs text-accent/80">{hms(e.at)}</time>
                <p className="mt-0.5 text-[15px] leading-snug text-hot">{e.text}</p>
                {e.reply && <p className="mt-1 line-clamp-3 text-sm leading-snug text-steel">{e.reply}</p>}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </div>
  );
}

interface RailProps extends StatusProps {
  data: Telemetry | null;
  battery: Battery | null;
  online: boolean;
  alerts: HudAlert[];
}
const TAB_KEY = 'jarvis-left-tab';

/** Left rail with two views: Status and live System telemetry. Jumps to System when a critical alert appears. */
export function LeftRail({ mode, levelRef, data, battery, online, alerts, voiceReady, imode }: RailProps) {
  const [tab, setTab] = useState<'status' | 'system'>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'status' ? 'status' : 'system';
    } catch {
      return 'system';
    }
  });
  const pick = (t: 'status' | 'system') => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* optional */
    }
  };
  const crit = alerts.filter((a) => a.level === 'crit').length;
  const seen = useRef(0);
  useEffect(() => {
    if (crit > seen.current) setTab('system');
    seen.current = crit;
  }, [crit]);

  const btn = (t: 'status' | 'system', label: string) => (
    <button
      type="button"
      onClick={() => pick(t)}
      className={`no-drag font-display text-[11px] font-bold uppercase tracking-[0.3em] transition-colors ${tab === t ? 'text-accent' : 'text-steel hover:text-hot'}`}
    >
      {label}
      {t === 'system' && alerts.length > 0 && <span className="ml-1 animate-pulse text-hot">●</span>}
    </button>
  );

  return (
    <div>
      <div className="mb-3 flex gap-5 pl-[18px]">
        {btn('system', 'System')}
        {btn('status', 'Status')}
      </div>
      {tab === 'system' ? <SystemPanel data={data} battery={battery} online={online} alerts={alerts} /> : <StatusPanel mode={mode} levelRef={levelRef} voiceReady={voiceReady} imode={imode} />}
    </div>
  );
}

/**
 * Right rail. Round 23: the Transcript and Activity tabs moved into Settings
 * (→ Transcript, → Activity) to declutter the execution interface; the rail keeps
 * the one thing that is about RIGHT NOW: the persistent task board.
 */
export function RightRail() {
  return <TaskRailPanel />;
}
