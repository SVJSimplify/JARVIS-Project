import { useState, type MutableRefObject, type ReactNode } from 'react';
import HologramCore from './HologramCore';
import Subtitles, { type Caption } from './Subtitles';
import SettingsPanel, { type SettingsSection } from './SettingsPanel';
import TaskProgress from './TaskProgress';
import ConversationsPanel from './ConversationsPanel';
import ProjectsPanel from './ProjectsPanel';
import OperationsPanel from './OperationsPanel';
import NativeBrowserPanel from './NativeBrowserPanel';
import ApprovalCard from './ApprovalCard';
import ToolActivitySummary from './ToolActivitySummary';
import { LeftRail, RightRail } from './HudPanels';
import { useTelemetry } from '../hooks/useTelemetry';
import type { JarvisMode, LogEntry } from '../lib/jarvisMode';
import type { InteractionMode } from '../lib/protocol';

interface Props {
  version: string;
  mode: JarvisMode;
  /** How JARVIS presents his work: interactive live feed or silent background. */
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
  children?: ReactNode;
}

export default function JarvisWindow({ version, mode, interactionMode, onSetMode, levelRef, log, caption, mini, voiceReady, turnsCount = 0, children }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('provider');
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const [nativeBrowserOpen, setNativeBrowserOpen] = useState(false);
  const tele = useTelemetry();
  const crit = tele.alerts.some((a) => a.level === 'crit');
  const bg = interactionMode === 'background';
  const openSettings = (section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };
  return (
    <div className="hud relative flex h-screen w-screen flex-col overflow-hidden" data-mode={mode} data-mini={mini}>
      <div className="hud-grid" />
      <div className="hud-vignette" />

      {/* The native titlebar overlay (window controls) sits on the right; the header
          reserves exactly its width through env(titlebar-area-*) in index.css — no fixed
          right-padding guess is needed and the controls never collide with it. */}
      <header className="hud-header relative z-20 flex h-10 shrink-0 items-center pl-3 min-[420px]:pl-6">
        <span className={`font-display font-bold ${mini ? 'text-[14px] tracking-[0.4em]' : 'text-[17px] tracking-[0.5em]'}`}>J.A.R.V.I.S</span>
        {!mini && <span className="ml-4 font-mono text-xs text-steel">v{version || '1.0.0'}</span>}
        {tele.alerts.length > 0 && (
          <span title={tele.alerts.map((a) => a.text).join('\n')} className={`ml-4 font-mono text-xs ${crit ? 'animate-pulse text-hot' : 'text-accent'}`}>
            ! {mini ? tele.alerts.length : tele.alerts[0].text}
          </span>
        )}
        {/* Round 23: the compact, live tool-activity summary (expandable). Replaces the
            old top-right Activity/Transcript tabs — the full interfaces live in Settings. */}
        {!mini && <ToolActivitySummary onOpenActivity={() => openSettings('activity')} />}
        {/* Fixed, non-shrinking hit targets: every header control is a 32px square and
            the cluster keeps its width under pressure (shrink-0). */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onSetMode(bg ? 'interactive' : 'background')}
            aria-label={bg ? 'Switch to interactive mode' : 'Switch to background mode'}
            title={bg ? 'Interactive mode — live feed of everything JINI does (Ctrl+Alt+B)' : 'Background mode — silent work, one notification when done (Ctrl+Alt+B)'}
            className="no-drag grid h-8 w-8 place-items-center text-steel transition-colors hover:text-accent"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              {bg ? (
                <path d="M20.4 14.2A8.3 8.3 0 0 1 9.8 3.6 8.3 8.3 0 1 0 20.4 14.2Z" />
              ) : (
                <>
                  <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
                  <circle cx="12" cy="12" r="2.6" />
                </>
              )}
            </svg>
          </button>
          <button
            type="button"
            onClick={() => void window.electronAPI.hud.setMini(!mini)}
            aria-label={mini ? 'Expand to full view' : 'Mini always-on-top HUD'}
            title="Ctrl+Alt+J"
            className="no-drag grid h-8 w-8 place-items-center text-steel transition-colors hover:text-accent"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              {mini ? <path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" /> : <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />}
            </svg>
          </button>
          {!mini && (
            <button
              type="button"
              onClick={() => setProjectsOpen(true)}
              aria-label="Projects"
              title="Projects — multi-step project orchestration with milestones, deliverables and durable history"
              className="no-drag grid h-8 w-8 place-items-center text-steel transition-colors hover:text-accent"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17v-9.5Z" />
                <path d="M7.5 12.5h5M7.5 15h3" />
              </svg>
            </button>
          )}
          {!mini && (
            <button
              type="button"
              onClick={() => setOpsOpen(true)}
              aria-label="Operations"
              title="Operations — active background work, recurring routines, execution history and the permission gate (Round 27)"
              className="no-drag grid h-8 w-8 place-items-center text-steel transition-colors hover:text-accent"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M17.5 14v7M14 17.5h7" />
              </svg>
            </button>
          )}
          {!mini && (
            <button
              type="button"
              onClick={() => setNativeBrowserOpen(true)}
              aria-label="Native browser"
              title="Native browser — let JINI use your real Chrome/Edge in background tabs (Round 28)"
              className="no-drag grid h-8 w-8 place-items-center text-steel transition-colors hover:text-accent"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" />
              </svg>
            </button>
          )}
          {!mini && (
            <button
              type="button"
              onClick={() => setConversationsOpen(true)}
              aria-label="Conversations"
              title="Conversation history — everything you asked, kept in full"
              className="no-drag grid h-8 w-8 place-items-center text-steel transition-colors hover:text-accent"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 4V5.5Z" />
                <path d="M8 9h8M8 12h5" />
              </svg>
            </button>
          )}
          {!mini && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Provider settings"
              className="no-drag grid h-8 w-8 place-items-center text-steel transition-colors hover:text-accent"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="8" cy="17" r="2" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        <HologramCore mode={mode} levelRef={levelRef} />
        <Subtitles caption={caption} />
        {/* Live task progress: what JARVIS is doing right now, in both modes. Auto-hides when idle. */}
        <TaskProgress mini={mini} />
        {/* Round 29 (§1.1): the user approval surface for consequential browser actions —
            rendered only when the main process has an open, genuinely user-decidable request. */}
        <ApprovalCard />
        <div className="absolute left-8 top-1/2 hidden -translate-y-1/2 min-[1180px]:block">
          <LeftRail mode={mode} levelRef={levelRef} data={tele.data} battery={tele.battery} online={tele.online} alerts={tele.alerts} voiceReady={voiceReady} imode={interactionMode} />
        </div>
        <div className="absolute right-8 top-1/2 hidden -translate-y-1/2 min-[1180px]:block">
          <RightRail />
        </div>
      </main>

      <footer className={`relative z-20 flex shrink-0 flex-col items-center ${mini ? 'gap-2 pb-3' : 'gap-3 pb-6'} pt-2`}>{children}</footer>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} log={log} initialSection={settingsSection} />

      <ConversationsPanel open={conversationsOpen} onClose={() => setConversationsOpen(false)} refreshKey={turnsCount} />

      <ProjectsPanel open={projectsOpen} onClose={() => setProjectsOpen(false)} />

      <OperationsPanel open={opsOpen} onClose={() => setOpsOpen(false)} />

      <NativeBrowserPanel open={nativeBrowserOpen} onClose={() => setNativeBrowserOpen(false)} />

      <i className="corner corner-tl" />
      <i className="corner corner-tr" />
      <i className="corner corner-br" />
      <i className="corner corner-bl" />
    </div>
  );
}
