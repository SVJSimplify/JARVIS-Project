import { AnimatePresence, motion } from 'framer-motion';
import { useActivity } from '../hooks/useActivity';
import type { ActivityEvent } from '../lib/protocol';

const pad = (n: number) => String(n).padStart(2, '0');
const hms = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const toneFor = (e: ActivityEvent): { glyph: string; cls: string } => {
  switch (e.status) {
    case 'ok':
      return { glyph: '✓', cls: 'text-accent' };
    case 'fail':
      return { glyph: '✗', cls: 'text-hot' };
    case 'held':
      return { glyph: '◇', cls: 'text-steel' };
    default:
      return { glyph: '◇', cls: 'animate-pulse text-steel' };
  }
};

/** Everything JARVIS does, as it happens: tools, progress, approvals, visuals. */
export default function ActivityFeed() {
  const items = useActivity();
  return (
    <aside className="rail w-72">
      <h2 className="rail-title">Activity</h2>
      {items.length === 0 ? (
        <p className="text-sm text-steel">Nothing has run yet.</p>
      ) : (
        <ol className="max-h-[430px] space-y-2.5 overflow-y-auto pr-1">
          <AnimatePresence initial={false}>
            {items.map((e) => {
              const tone = toneFor(e);
              return (
                <motion.li
                  key={e.cid ?? e.id}
                  layout
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="flex items-baseline gap-2">
                    <time className="font-mono text-[10px] text-accent/70">{hms(new Date(e.t))}</time>
                    <span className={`font-mono text-[11px] leading-none ${tone.cls}`}>{tone.glyph}</span>
                    <span className="truncate text-[13px] leading-snug text-hot">{e.label}</span>
                    {e.ms !== undefined && <span className="ml-auto shrink-0 font-mono text-[10px] text-steel">{e.ms}ms</span>}
                  </div>
                  {e.detail && <p className="mt-0.5 line-clamp-2 pl-9 text-[11px] leading-snug text-steel">{e.detail}</p>}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
    </aside>
  );
}
