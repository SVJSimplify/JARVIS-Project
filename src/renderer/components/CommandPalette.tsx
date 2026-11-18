import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

type Destination = 'assistant' | 'projects' | 'operations' | 'history' | 'browser' | 'devices' | 'settings' | 'activity';

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigate: (destination: Destination) => void;
}

const COMMANDS: Array<{ id: Destination; title: string; detail: string; keys: string }> = [
  { id: 'assistant', title: 'Go to Assistant', detail: 'Return to your conversation', keys: 'A' },
  { id: 'projects', title: 'Open Projects', detail: 'Browse projects and deliverables', keys: 'P' },
  { id: 'operations', title: 'Open Operations', detail: 'Tasks, schedules and integrations', keys: 'O' },
  { id: 'history', title: 'Search History', detail: 'Find a previous conversation', keys: 'H' },
  { id: 'browser', title: 'Open Browser', detail: 'Continue a connected browser session', keys: 'B' },
  { id: 'devices', title: 'Manage Devices', detail: 'Connections and paired devices', keys: 'D' },
  { id: 'settings', title: 'Open Settings', detail: 'Preferences, providers and privacy', keys: ',' },
  { id: 'activity', title: 'View Activity', detail: 'Recent tool calls and execution events', keys: '⌘  J' },
];

export default function CommandPalette({ open, onClose, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return COMMANDS.filter((item) => !q || `${item.title} ${item.detail}`.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
      return;
    }
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const choose = (id: Destination) => {
    onNavigate(id);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="command-backdrop no-drag fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="command-palette w-full max-w-[560px] overflow-hidden rounded-2xl border border-hairline bg-surface shadow-[0_24px_80px_rgba(38,29,19,0.2)]"
            initial={{ opacity: 0, y: -12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.99 }}
            transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, filtered.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter' && filtered[active]) {
                event.preventDefault();
                choose(filtered[active].id);
              } else if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
              }
            }}
          >
            <div className="flex items-center gap-3 border-b border-hairline px-4">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
              </svg>
              <input
                ref={input}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Where would you like to go?"
                aria-label="Search commands"
                className="h-[58px] min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
              />
              <kbd className="rounded-md border border-hairline bg-paper px-2 py-1 text-[11px] text-faint">ESC</kbd>
            </div>
            <div className="px-2 py-2">
              <p className="px-3 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">Navigation</p>
              {filtered.length ? filtered.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(item.id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${active === index ? 'bg-[#F1EBE0] text-ink' : 'text-body hover:bg-black/[0.03]'}`}
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hairline bg-paper text-[12px] font-semibold text-clay">{item.title.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{item.title}</span>
                    <span className="mt-0.5 block text-[11.5px] text-faint">{item.detail}</span>
                  </span>
                  <kbd className="text-[10px] text-faint">{item.keys}</kbd>
                </button>
              )) : (
                <p className="px-3 py-8 text-center text-[13px] text-muted">No matching commands</p>
              )}
            </div>
            <footer className="flex items-center justify-between border-t border-hairline bg-paper/70 px-4 py-2.5 text-[10.5px] text-faint">
              <span>Navigate JINI</span><span>↑ ↓ move · ↵ select</span>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
