import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Caption } from './Subtitles';
import SettingsPanel, { type SettingsSection } from './SettingsPanel';
import TaskProgress, { TaskRailPanel } from './TaskProgress';
import ConversationsPanel from './ConversationsPanel';
import ProjectsPanel from './ProjectsPanel';
import OperationsPanel from './OperationsPanel';
import NativeBrowserPanel from './NativeBrowserPanel';
import ApprovalCard from './ApprovalCard';
import ToolActivitySummary from './ToolActivitySummary';
import SystemPanel from './SystemPanel';
import JiniOrb from './JiniOrb';
import CommandPalette from './CommandPalette';
import { useTelemetry } from '../hooks/useTelemetry';
import { useClock } from '../hooks/useClock';
import { MODE_LABEL, type JarvisMode, type LogEntry } from '../lib/jarvisMode';
import type { InteractionMode } from '../lib/protocol';
import type { ChatInfo, HistoryTurn } from '../../main/protocol';

interface Props {
  version: string;
  mode: JarvisMode;
  /** How JINI presents its work: interactive live feed or silent background. */
  interactionMode: InteractionMode;
  onSetMode: (m: InteractionMode) => void;
  levelRef: MutableRefObject<number>;
  log: LogEntry[];
  caption: Caption | null;
  mini: boolean;
  voiceReady: boolean;
  /** Bumped by App after every finished turn; while the Conversations panel is open this
   *  triggers a refetch, so new conversations appear without closing and reopening. */
  turnsCount?: number;
  /** A chat was opened (or created): its turns replace the visible thread. */
  onOpenChat?: (turns: HistoryTurn[]) => void;
  /** Sends a request exactly as if typed (used by the starter suggestions). */
  onSuggest?: (text: string) => void;
  children?: ReactNode;
}

type Panel = 'projects' | 'operations' | 'conversations' | 'browser' | null;

/** One icon family (Lucide geometry): 24px grid, 1.6 stroke, round joins. */
const ICON = {
  assistant: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  projects: ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'],
  operations: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M17.5 14v7', 'M14 17.5h7'],
  plus: ['M12 5v14', 'M5 12h14'],
  history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  browser: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
  devices: ['M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 18h.01'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  compact: ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  memory: ['M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'M12 10v6', 'M9 13h6'],
  pulse: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  news: ['M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2', 'M18 14h-8', 'M15 18h-5', 'M10 6h8v4h-8V6Z'],
} as const;
type IconName = keyof typeof ICON;

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Real requests JINI can act on immediately (sent exactly as if typed). Each has its own warm tint. */
const SUGGESTIONS: Array<{ icon: IconName; title: string; detail: string; prompt: string; tint: string }> = [
  {
    icon: 'memory',
    title: 'What do you know about me?',
    detail: 'Review and correct what JINI remembers',
    prompt: 'What do you remember about me? List it so I can correct anything that is wrong.',
    tint: 'bg-[#F6E4D8] text-clay',
  },
  {
    icon: 'pulse',
    title: 'Check this computer',
    detail: 'CPU, memory, disk space and anything unusual',
    prompt: 'How is this computer doing? Check CPU, memory, disk space and anything unusual, and tell me if something needs attention.',
    tint: 'bg-[#E1EBDD] text-sage',
  },
  {
    icon: 'folder',
    title: 'Tidy my Downloads',
    detail: 'A plan first — nothing moves without your OK',
    prompt: 'Look at my Downloads folder and suggest how to organise it. Do not move or delete anything until I approve the plan.',
    tint: 'bg-[#F4E7CF] text-ochre',
  },
  {
    icon: 'news',
    title: 'Brief me on tech news',
    detail: 'Today’s top three stories, two lines each',
    prompt: 'Find today’s top three technology news stories and summarise each in two sentences, with sources.',
    tint: 'bg-[#E0E7EE] text-slate',
  },
];

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

const navItemClass = (active: boolean) =>
  `group flex h-[34px] items-center gap-2.5 rounded-[9px] px-2.5 text-[13.5px] transition-colors ${
    active ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(60,42,20,0.07)] ring-1 ring-hairline' : 'text-body hover:bg-black/[0.035] hover:text-ink'
  }`;

export default function JarvisWindow({ version, mode, interactionMode, levelRef, log, caption, mini, voiceReady, turnsCount = 0, onSuggest, onOpenChat, children }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('provider');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const tele = useTelemetry();
  const openSettings = (section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  const panels = (
    <>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} log={log} initialSection={settingsSection} />
      <ConversationsPanel open={panel === 'conversations'} onClose={() => setPanel(null)} refreshKey={turnsCount} />
      <ProjectsPanel open={panel === 'projects'} onClose={() => setPanel(null)} />
      <OperationsPanel open={panel === 'operations'} onClose={() => setPanel(null)} />
      <NativeBrowserPanel open={panel === 'browser'} onClose={() => setPanel(null)} />
      <TaskProgress mini={mini} />
      <ApprovalCard />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(destination) => {
          if (destination === 'assistant') { setPanel(null); setSettingsOpen(false); }
          else if (destination === 'projects') { setSettingsOpen(false); setPanel('projects'); }
          else if (destination === 'operations') { setSettingsOpen(false); setPanel('operations'); }
          else if (destination === 'history') { setSettingsOpen(false); setPanel('conversations'); }
          else if (destination === 'browser') { setSettingsOpen(false); setPanel('browser'); }
          else if (destination === 'devices') openSettings('devices');
          else if (destination === 'settings') openSettings('provider');
          else if (destination === 'activity') openSettings('activity');
        }}
      />
    </>
  );

  if (mini) {
    return (
      <div className="hud flex h-screen w-screen flex-col overflow-hidden bg-paper" data-mode={mode} data-mini="true">
        <header className="hud-header mini-drag flex h-9 shrink-0 items-center gap-2 pl-3">
          <Wordmark small />
          <span className="text-[12px] text-faint">{mode === 'idle' ? 'Ready' : MODE_LABEL[mode]}</span>
          <button
            type="button"
            onClick={() => void window.electronAPI.hud.setMini(false)}
            aria-label="Expand to full window"
            title="Expand (Ctrl+Alt+J)"
            className="no-drag ml-auto grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-black/[0.04] hover:text-ink"
          >
            <Icon name="expand" size={15} />
          </button>
        </header>
        <main className="mini-drag flex min-h-0 flex-1 items-center gap-3 px-4">
          <JiniOrb mode={mode} levelRef={levelRef} size={30} />
          <p className={`line-clamp-3 min-w-0 flex-1 text-[13.5px] leading-5 ${caption?.tone === 'error' ? 'text-danger' : 'text-body'}`} aria-live="polite">
            {caption?.text || log[0]?.reply || 'Ready when you are.'}
          </p>
        </main>
        <footer className="no-drag flex shrink-0 items-end gap-2 px-3 pb-3">{children}</footer>
        {panels}
      </div>
    );
  }

  const nav: Array<{ id: string; label: string; icon: IconName; onClick: () => void; active: boolean }> = [
    { id: 'assistant', label: 'Assistant', icon: 'assistant', onClick: () => setPanel(null), active: !panel && !settingsOpen },
    { id: 'projects', label: 'Projects', icon: 'projects', onClick: () => setPanel('projects'), active: panel === 'projects' },
    { id: 'operations', label: 'Operations', icon: 'operations', onClick: () => setPanel('operations'), active: panel === 'operations' },
    { id: 'history', label: 'History', icon: 'history', onClick: () => setPanel('conversations'), active: panel === 'conversations' },
  ];
  const connected: typeof nav = [
    { id: 'browser', label: 'Browser', icon: 'browser', onClick: () => setPanel('browser'), active: panel === 'browser' },
    { id: 'devices', label: 'Devices', icon: 'devices', onClick: () => openSettings('devices'), active: settingsOpen && settingsSection === 'devices' },
  ];

  const navButton = (n: (typeof nav)[number]) => (
    <button key={n.id} type="button" onClick={n.onClick} aria-current={n.active ? 'page' : undefined} className={navItemClass(n.active)}>
      <span className={`transition-colors ${n.active ? 'text-clay' : 'text-faint group-hover:text-muted'}`}>
        <Icon name={n.icon} size={16} />
      </span>
      {n.label}
    </button>
  );

  return (
    <div className="hud jini-shell flex h-screen w-screen overflow-hidden bg-oat" data-mode={mode} data-mini="false">
      {/* ------------------------------------------------ sidebar (oat chrome) */}
      <aside className="jini-sidebar flex w-[236px] shrink-0 flex-col">
        <div className="drag flex h-[56px] items-center px-5 pt-1">
          <Wordmark />
        </div>
        <nav className="no-drag flex flex-col gap-0.5 px-3 pt-1" aria-label="Workspace">
          {nav.map(navButton)}
        </nav>
        <ChatsNav onOpen={(turns) => { setPanel(null); onOpenChat?.(turns); }} turnsCount={turnsCount} />
        <p className="mb-1.5 mt-5 px-5 text-[11.5px] font-medium text-faint">Connected</p>
        <nav className="no-drag flex flex-col gap-0.5 px-3" aria-label="Connections">
          {connected.map(navButton)}
        </nav>

        <div className="no-drag mt-auto px-3 pb-3">
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => openSettings('provider')} className={`${navItemClass(settingsOpen && settingsSection !== 'devices')} flex-1`}>
              <span className="text-faint group-hover:text-muted">
                <Icon name="settings" size={16} />
              </span>
              Settings
            </button>
            <button
              type="button"
              onClick={() => void window.electronAPI.hud.setMini(true)}
              aria-label="Compact always-on-top window"
              title="Compact window (Ctrl+Alt+J)"
              className="grid h-[34px] w-[34px] place-items-center rounded-[9px] text-faint transition-colors hover:bg-black/[0.035] hover:text-ink"
            >
              <Icon name="compact" size={16} />
            </button>
          </div>
          <p className="mt-2 px-2.5 text-[11px] text-faint">JINI {version || '1.0.0'}</p>
        </div>
      </aside>

      {/* ------------------------------------------------ canvas (paper) */}
      <div className="jini-canvas my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-hairline bg-paper shadow-[0_1px_3px_rgba(60,42,20,0.06)]">
        <header className="hud-header jini-toolbar relative z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline pl-6 pr-5">
          <h2 className="text-[14px] font-semibold text-ink">Assistant</h2>
          <StatusChip mode={mode} quiet={interactionMode === 'background'} />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="no-drag command-trigger ml-auto inline-flex h-8 items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 text-[11.5px] text-faint transition-colors hover:border-sand hover:text-ink"
            aria-label="Open command palette"
            title="Search navigation and commands (Ctrl+K)"
          >
            <span className="text-[13px]">⌕</span><span>Quick open</span><kbd className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-[10px]">Ctrl K</kbd>
          </button>
          <div className="no-drag ml-1">
            <ToolActivitySummary onOpenActivity={() => openSettings('activity')} />
          </div>
          {tele.alerts.length > 0 && (
            <span title={tele.alerts.map((a) => a.text).join('\n')} className={`truncate text-[12.5px] ${tele.alerts.some((a) => a.level === 'crit') ? 'text-danger' : 'text-warn'}`}>
              {tele.alerts[0].text}
            </span>
          )}
        </header>

        <div className="jini-workspace flex min-h-0 flex-1">
          <section className="jini-main relative flex min-w-0 flex-1 flex-col">
            {log.length === 0 ? (
              <EmptyState mode={mode} levelRef={levelRef} voiceReady={voiceReady} onSuggest={onSuggest} />
            ) : (
              <Thread log={log} caption={caption} mode={mode} levelRef={levelRef} />
            )}
            <footer className="relative z-20 shrink-0 px-8 pb-6 pt-2">
              <div className="mx-auto w-full max-w-[720px]">{children}</div>
            </footer>
          </section>

          <aside className="jini-inspector hidden w-[296px] shrink-0 flex-col gap-7 overflow-y-auto overflow-x-hidden border-l border-hairline px-5 py-6 min-[1240px]:flex">
            <Today />
            <TaskRailPanel />
            <SystemPanel data={tele.data} battery={tele.battery} online={tele.online} alerts={tele.alerts} />
          </aside>
        </div>
      </div>

      {panels}
    </div>
  );
}

function Wordmark({ small }: { small?: boolean }) {
  return (
    <span className={`font-serif-display font-semibold tracking-[-0.02em] text-ink ${small ? 'text-[15px]' : 'text-[23px]'}`}>
      jini<span className="text-clay">.</span>
    </span>
  );
}

function StatusChip({ mode, quiet }: { mode: JarvisMode; quiet: boolean }) {
  const busy = mode !== 'idle';
  return (
    <span className="flex h-7 items-center gap-2 rounded-full border border-hairline bg-surface px-3 text-[12.5px] text-muted">
      <span className={`h-1.5 w-1.5 rounded-full ${busy ? 'bg-clay' : 'bg-sage'}`} />
      {busy ? MODE_LABEL[mode] : 'Ready'}
      {quiet && <span className="text-faint">· Quiet</span>}
    </span>
  );
}

function Today() {
  const now = useClock();
  return (
    <section aria-label="Today">
      <p className="text-[12px] text-faint">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <p className="font-serif-display mt-0.5 text-[30px] font-normal tabular-nums tracking-[-0.01em] text-ink">
        {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </p>
    </section>
  );
}

function EmptyState({ mode, levelRef, voiceReady, onSuggest }: { mode: JarvisMode; levelRef: MutableRefObject<number>; voiceReady: boolean; onSuggest?: (t: string) => void }) {
  return (
    <div className="jini-empty flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-10">
      <JiniOrb mode={mode} levelRef={levelRef} size={76} />
      <h1 className="font-serif-display mt-9 text-[42px] font-normal leading-[1.1] tracking-[-0.02em] text-ink">{greeting()}.</h1>
      <p className="mt-3 max-w-[460px] text-center text-[15px] leading-6 text-muted">
        What should we work on? Ask anything, hand JINI a task for this computer, or just start talking.
      </p>
      {!voiceReady && <p className="mt-2 text-[12.5px] text-faint">Voice is getting ready — typing works now.</p>}
      {onSuggest && (
        <div className="mt-10 grid w-full max-w-[640px] grid-cols-2 gap-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => onSuggest(s.prompt)}
              className="group flex items-start gap-3 rounded-2xl border border-hairline bg-surface p-4 text-left shadow-[0_1px_2px_rgba(60,42,20,0.04)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-sand hover:shadow-[0_8px_20px_rgba(60,42,20,0.08)]"
            >
              <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${s.tint}`}>
                <Icon name={s.icon} size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-ink">{s.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-5 text-faint group-hover:text-muted">{s.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The session as a conversation, oldest first; the newest reply streams in live. */
function Thread({ log, caption, mode, levelRef }: { log: LogEntry[]; caption: Caption | null; mode: JarvisMode; levelRef: MutableRefObject<number> }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => [...log].reverse(), [log]);
  const last = turns[turns.length - 1];

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, caption?.text, last?.reply]);

  return (
    <div className="jini-thread min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] space-y-8 px-8 pb-6 pt-8">
        {turns.map((t) => {
          const isLast = t === last;
          const streaming = isLast && !t.reply;
          const time = t.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
          return (
            <div key={t.id} className="space-y-5">
              <div className="anim-enter flex justify-end">
                <p className="max-w-[78%] whitespace-pre-wrap rounded-[20px] rounded-br-md bg-[#EFE7DA] px-4 py-2.5 text-[15px] leading-6 text-ink" title={time}>
                  {t.text}
                </p>
              </div>
              <div className="anim-enter">
                <div className="mb-2 flex items-center gap-2">
                  <JiniOrb mode={isLast ? mode : 'idle'} levelRef={levelRef} size={18} />
                  <span className="text-[13px] font-semibold text-ink">JINI</span>
                  <span className="text-[12px] text-faint">{time}</span>
                </div>
                <div className="pl-[26px]">
                  {streaming ? (
                    caption?.text ? (
                      <p className={`whitespace-pre-wrap text-[15px] leading-7 ${caption.tone === 'error' ? 'text-danger' : 'text-body'}`} aria-live="polite">
                        {caption.text}
                      </p>
                    ) : (
                      <p className="typing-dots pt-2 text-faint" role="status" aria-label="JINI is working">
                        <span />
                        <span />
                        <span />
                      </p>
                    )
                  ) : (
                    <p className={`whitespace-pre-wrap text-[15px] leading-7 ${t.reply === '(interrupted)' ? 'italic text-faint' : 'text-body'}`}>
                      {t.reply === '(interrupted)' ? 'Stopped.' : t.reply}
                    </p>
                  )}
                  {t.image && (
                    <button type="button" onClick={() => setZoom(t.image ?? null)} className="mt-3 block overflow-hidden rounded-xl border border-hairline" aria-label="Enlarge screenshot">
                      <img src={t.image} alt="Screenshot JINI took" className="max-h-[320px] w-auto max-w-full" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {zoom && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-8" onClick={() => setZoom(null)} role="dialog" aria-label="Screenshot">
          <img src={zoom} alt="Screenshot JINI took" className="max-h-full max-w-full rounded-xl shadow-2xl" />
        </div>
      )}
    </div>
  );
}

/** Sidebar chat list: new / switch / rename / delete. The same list the paired phone shows. */
function ChatsNav({ onOpen, turnsCount }: { onOpen: (turns: HistoryTurn[]) => void; turnsCount: number }) {
  const api = window.electronAPI.chats;
  const [data, setData] = useState<{ active: string; chats: ChatInfo[] }>({ active: '', chats: [] });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const refresh = useCallback(() => void api.list().then(setData).catch(() => undefined), [api]);
  useEffect(() => {
    refresh();
    return api.onChanged(refresh);
  }, [api, refresh]);
  useEffect(refresh, [turnsCount, refresh]);
  // Opening the app shows the chat you were last in.
  useEffect(() => {
    void api.list().then((d) => d.active && api.turns(d.active).then(onOpen)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (id: string) => {
    await api.select(id);
    onOpen(await api.turns(id));
    refresh();
  };
  const create = async () => {
    await api.create();
    onOpen([]);
    refresh();
  };
  const commitRename = async (id: string) => {
    const t = draft.trim();
    setEditing(null);
    if (t) await api.rename(id, t).catch(() => undefined);
    refresh();
  };
  const remove = async (c: ChatInfo) => {
    if (!window.confirm(`Delete "${c.title}" and its messages? This can't be undone.`)) return;
    await api.remove(c.id);
    const d = await api.list();
    onOpen(d.active ? await api.turns(d.active) : []);
    refresh();
  };

  return (
    <div className="no-drag mt-6 flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex items-center justify-between pl-5 pr-3">
        <p className="text-[11.5px] font-medium text-faint">Chats</p>
        <button type="button" onClick={() => void create()} title="New chat" aria-label="New chat" className="grid h-6 w-6 place-items-center rounded-md text-faint transition-colors hover:bg-black/[0.04] hover:text-ink">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-3" aria-label="Chats">
        {data.chats.length === 0 && <li className="px-2.5 py-1.5 text-[12.5px] text-faint">No chats yet</li>}
        {data.chats.map((c) => {
          const active = c.id === data.active;
          return (
            <li key={c.id} className="group relative">
              {editing === c.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(c.id);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  className="w-full rounded-[8px] border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-sand"
                  aria-label="Chat title"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => void open(c.id)}
                  onDoubleClick={() => {
                    setEditing(c.id);
                    setDraft(c.title);
                  }}
                  aria-current={active ? 'true' : undefined}
                  className={`block w-full truncate rounded-[8px] py-1.5 pl-2.5 pr-14 text-left text-[13px] transition-colors ${active ? 'bg-black/[0.05] text-ink' : 'text-muted hover:bg-black/[0.03] hover:text-ink'}`}
                  title={c.title}
                >
                  {c.title}
                </button>
              )}
              {editing !== c.id && (
                <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover:flex">
                  <button type="button" className="rounded px-1 text-[11px] text-faint hover:text-ink" onClick={() => { setEditing(c.id); setDraft(c.title); }} aria-label={`Rename ${c.title}`}>
                    Rename
                  </button>
                  <button type="button" className="rounded px-1 text-[11px] text-faint hover:text-brick" onClick={() => void remove(c)} aria-label={`Delete ${c.title}`}>
                    ✕
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
