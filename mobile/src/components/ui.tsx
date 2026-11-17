import type { ReactNode } from 'react';
import { useAppState } from '../lib/store';
import { retryNow } from '../lib/linkClient';

/** One icon family: 24px grid, 1.75 stroke, round caps (Lucide geometry). */
const ICONS = {
  chat: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  tasks: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  memory: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'],
  settings: ['M21 4h-7', 'M10 4H3', 'M21 12h-9', 'M8 12H3', 'M21 20h-5', 'M12 20H3', 'M14 2v4', 'M8 10v4', 'M16 18v4'],
  send: ['m5 12 7-7 7 7', 'M12 19V5'],
  plus: ['M5 12h14', 'M12 5v14'],
  search: ['M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'm21 21-4.3-4.3'],
  scan: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M7 12h10'],
  monitor: ['M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M8 20h8', 'M12 16v4'],
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Connection state: a quiet dot + words (tap to retry). Never colour alone. */
export function ConnectionStatus() {
  const { connection, link, outbox } = useAppState((s) => ({ connection: s.connection, link: s.link, outbox: s.outbox.length }));
  const map = {
    online: { dot: 'bg-ok', text: 'Desktop connected' },
    connecting: { dot: 'bg-warn', text: 'Connecting…' },
    offline: { dot: 'bg-faint', text: 'Desktop offline' },
    unpaired: { dot: 'bg-faint', text: link?.revoked ? 'Revoked' : 'Not paired' },
  } as const;
  const m = map[connection];
  return (
    <button onClick={retryNow} className="flex items-center gap-2 py-1 text-meta text-muted active:opacity-70" aria-label={`${m.text}. Tap to reconnect.`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.text}
      {outbox > 0 && <span className="text-warn">· {outbox} queued</span>}
    </button>
  );
}

export function ScreenHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between px-1 pb-2 pt-2">
      <h2 className="font-serif-display text-title text-text">{title}</h2>
      {action}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="px-6 pt-24 text-center">
      <p className="text-[17px] font-medium text-text">{title}</p>
      <p className="mx-auto mt-2 max-w-[290px] text-body text-muted">{hint}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
