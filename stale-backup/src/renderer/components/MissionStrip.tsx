import { useEffect, useRef, useState } from 'react';

/**
 * Live Mission Control strip. Background missions push one event per state transition;
 * this renders the newest one and hides itself when nothing is running (and briefly after
 * a finish, so the outcome is seen). Old missions' late events never overwrite newer ones.
 */
interface MissionProgress {
  id: number;
  status: string;
  note: string;
  done: number;
  total: number;
}

const ACTIVE = new Set(['planning', 'running', 'verifying']);

export default function MissionStrip() {
  const [p, setP] = useState<MissionProgress | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const off = window.electronAPI.on('mission-progress', (raw) => {
      const m = raw as MissionProgress | null;
      if (!m || typeof m.id !== 'number' || typeof m.status !== 'string') return;
      if (m.id < latest.current) return;
      latest.current = m.id;
      setP(m);
      if (!ACTIVE.has(m.status)) {
        setTimeout(() => setP((cur) => (cur && cur.id === m.id ? null : cur)), 12000);
      }
    });
    return off;
  }, []);

  if (!p) return null;
  const active = ACTIVE.has(p.status);
  return (
    <div
      className={`no-drag max-w-[92vw] truncate rounded-full border px-4 py-1 font-mono text-xs tracking-wide ${
        active ? 'border-accent/40 text-accent' : p.status === 'failed' ? 'border-hot/50 text-hot' : 'border-steel/30 text-steel'
      }`}
      title={`${p.note || ''}`}
    >
      MISSION #{p.id} · {p.status.toUpperCase()}
      {p.total > 0 && ` · ${p.done}/${p.total} steps`}
      {p.note ? ` · ${p.note}` : ''}
    </div>
  );
}
