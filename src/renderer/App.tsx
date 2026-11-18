import { useCallback, useEffect, useRef, useState } from 'react';
import JarvisWindow from './components/JarvisWindow';
import VoiceInput from './components/VoiceInput';
import TextCommand from './components/TextCommand';
import VisualCard from './components/VisualCard';
import { isModalOpen } from './lib/modalState';
import { useJarvisMode } from './hooks/useJarvisMode';
import { useVoiceAgent } from './hooks/useVoiceAgent';
import { useSubtitles } from './hooks/useSubtitles';
import { useMode } from './hooks/useMode';
import type { NotifyPayload } from './lib/protocol';
import type { LogEntry } from './lib/jarvisMode';
import './index.css';

// Round 23: the in-session transcript moved into Settings → Transcript, where it has
// room to be useful. The old right-rail tab kept only the last 6 entries — history that
// silently vanished — so the session log now retains the whole session (memory-bounded,
// not a display constraint). The durable full-fidelity record of every past session
// remains in history.ts (Conversations), untouched.
const LOG_LIMIT = 500;
let lastSay = 0;

const cleanError = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function App() {
  const [version, setVersion] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [mini, setMini] = useState(false);
  // Bumped after every finished turn (success, failure, interruption — history records
  // all of them); the Conversations panel refetches when it sees the number change.
  const [turnsCount, setTurnsCount] = useState(0);
  const [caption, subtitles] = useSubtitles();
  const { mode: imode, set: setImode } = useMode();
  const imodeRef = useRef(imode); // the speech gate must read the CURRENT mode, not a stale closure
  imodeRef.current = imode;
  const turnRef = useRef(0); // id of the newest request; older ones must not touch the UI

  const cancelTurn = useCallback(() => {
    turnRef.current++;
    setBusy(false);
    subtitles.stop();
    void (window.electronAPI as unknown as { ai: { cancel?: () => Promise<void> } }).ai.cancel?.();
  }, [subtitles]);

  useEffect(() => window.electronAPI.hud.onMini(setMini), []);
  // A screenshot taken during the current turn appears on that turn's entry.
  useEffect(
    () =>
      window.electronAPI.onScreenshot((image) =>
        setLog((prev) => (prev.length ? [{ ...prev[0], image }, ...prev.slice(1)] : prev))
      ),
    []
  );

  useEffect(() => {
    window.electronAPI?.getAppVersion().then(setVersion).catch(() => {});
  }, []);

  // Esc silences JARVIS and cancels whatever he is doing — unless a modal is open, where Esc means "close this panel".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isModalOpen()) return;
      cancelTurn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelTurn]);

  const handleCommand = useCallback(
    async (cmd: string) => {
      const my = ++turnRef.current;
      const id = Date.now();
      const setReply = (reply: string) =>
        setLog((prev) => prev.map((e) => (e.id === id ? { ...e, reply } : e)));

      setLog((prev) => [{ id, at: new Date(), text: cmd }, ...prev].slice(0, LOG_LIMIT));
      setBusy(true);
      // Background mode keeps the transcript but holds the voice: no captions, no TTS,
      // until the end-of-task notification.
      const live = imodeRef.current === 'interactive';
      if (live) {
        subtitles.stop(); // cut off any reply still being spoken (this request may be an interruption)
        subtitles.begin();
      }
      try {
        const reply = await window.electronAPI.ai.chat(cmd, () => undefined);
        if (turnRef.current !== my) return setReply('(interrupted)');
        if (live) {
          subtitles.finish(reply);
          setReply(reply);
        } else {
          setReply(reply); // the end notification (below) speaks the summary instead
        }
      } catch (err) {
        if (turnRef.current !== my) return setReply('(interrupted)');
        const message = cleanError(err);
        if (live) subtitles.fail(message);
        setReply(message);
      } finally {
        if (turnRef.current === my) {
          setBusy(false);
          setTurnsCount((c) => c + 1); // the durable history has a new turn by now
        }
      }
    },
    [subtitles]
  );

  const speak = useCallback(
    (text: string) => {
      subtitles.begin();
      subtitles.finish(text);
    },
    [subtitles]
  );

  const speakRef = useRef(speak);
  speakRef.current = speak;
  useEffect(() =>
    window.electronAPI.on('jarvis-say', (t) => {
      if (Date.now() - lastSay < 1000) return;
      lastSay = Date.now();
      speakRef.current(String(t));
    }), []);

  useEffect(() => {
    const off = window.electronAPI.on('jarvis-notify', (p) => {
      const n = p as NotifyPayload;
      if (!n || typeof n.speakLine !== 'string' || !n.speakLine) return;
      speakRef.current(n.speakLine);
    });
    return off;
  }, []);

  const voice = useVoiceAgent({ onCommand: handleCommand, onCancel: cancelTurn, speak, busy });
  const mode = useJarvisMode(voice.mode !== 'idle' ? voice.mode : busy ? 'thinking' : 'idle');

  return (
    <JarvisWindow
      version={version}
      mode={mode}
      interactionMode={imode}
      onSetMode={setImode}
      levelRef={voice.levelRef}
      log={log}
      caption={caption}
      mini={mini}
      voiceReady={voice.ready}
      turnsCount={turnsCount}
      onSuggest={handleCommand}
      onOpenChat={(turns) =>
        setLog(
          turns
            .slice(-LOG_LIMIT)
            .reverse()
            .map((t, i) => ({ id: t.t * 100 + i, at: new Date(t.t), text: t.user, reply: t.error ? `Couldn't finish: ${t.error}` : t.reply }))
        )
      }
    >
      <TextCommand
        onSubmit={handleCommand}
        busy={busy}
        compact={mini}
        mode={imode}
        onModeChange={setImode}
        leading={<VoiceInput live={voice.live} mode={voice.mode} hint={voice.hint} onToggle={voice.toggle} compact={mini} />}
      />
      <VisualCard />
    </JarvisWindow>
  );
}
