import { useState, type MutableRefObject, type ReactNode } from 'react';
import HologramCore from './HologramCore';
import Subtitles, { type Caption } from './Subtitles';
import SettingsPanel from './SettingsPanel';
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
  children?: ReactNode;
}

export default function JarvisWindow({ version, mode, interactionMode, onSetMode, levelRef, log, caption, mini, voiceReady, children }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tele = useTelemetry();
  const crit = tele.alerts.some((a) => a.level === 'crit');
  const bg = interactionMode === 'background';
  return (
    <div className="hud relative flex h-screen w-screen flex-col overflow-hidden" data-mode={mode} data-mini={mini}>
      <div className="hud-grid" />
      <div className="hud-vignette" />

      <header className={`hud-header relative z-20 flex h-10 shrink-0 items-center ${mini ? 'pl-3 pr-36' : 'pl-6 pr-40'}`}>
        <span className={`font-display font-bold ${mini ? 'text-[14px] tracking-[0.4em]' : 'text-[17px] tracking-[0.5em]'}`}>J.A.R.V.I.S</span>
        {!mini && <span className="ml-4 font-mono text-xs text-steel">v{version || '1.0.0'}</span>}
        {tele.alerts.length > 0 && (
          <span title={tele.alerts.map((a) => a.text).join('\n')} className={`ml-4 font-mono text-xs ${crit ? 'animate-pulse text-hot' : 'text-accent'}`}>
            ! {mini ? tele.alerts.length : tele.alerts[0].text}
          </span>
        )}
        <button
          type="button"
          onClick={() => onSetMode(bg ? 'interactive' : 'background')}
          aria-label={bg ? 'Switch to interactive mode' : 'Switch to background mode'}
          title={bg ? 'Interactive mode — live feed of everything JARVIS does (Ctrl+Alt+B)' : 'Background mode — silent work, one notification when done (Ctrl+Alt+B)'}
          className="no-drag ml-auto mr-3 flex items-center gap-2 text-steel transition-colors hover:text-accent"
        >
          {!mini && (
            <span className={`font-display text-[10px] font-bold uppercase tracking-[0.3em] ${bg ? '' : 'text-accent'}`}>
              {bg ? 'Background' : 'Interactive'}
            </span>
          )}
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
          className="no-drag mr-2 text-steel transition-colors hover:text-accent"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {mini ? <path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" /> : <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />}
          </svg>
        </button>
        {!mini && <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Provider settings"
          className="no-drag mr-2 text-steel transition-colors hover:text-accent"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </svg>
        </button>}
      </header>

      <main className="relative min-h-0 flex-1">
        <HologramCore mode={mode} levelRef={levelRef} />
        <Subtitles caption={caption} />
        <div className="absolute left-8 top-1/2 hidden -translate-y-1/2 min-[1180px]:block">
          <LeftRail mode={mode} levelRef={levelRef} data={tele.data} battery={tele.battery} online={tele.online} alerts={tele.alerts} voiceReady={voiceReady} imode={interactionMode} />
        </div>
        <div className="absolute right-8 top-1/2 hidden -translate-y-1/2 min-[1180px]:block">
          <RightRail log={log} />
        </div>
      </main>

      <footer className={`relative z-20 flex shrink-0 flex-col items-center ${mini ? 'gap-2 pb-3' : 'gap-3 pb-6'} pt-2`}>{children}</footer>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <i className="corner corner-tl" />
      <i className="corner corner-tr" />
      <i className="corner corner-br" />
      <i className="corner corner-bl" />
    </div>
  );
}
