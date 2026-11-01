import { useCallback, useEffect, useRef, useState } from 'react';
import JarvisWindow from './components/JarvisWindow';
import VoiceInput from './components/VoiceInput';
import TextCommand from './components/TextCommand';
import ConfirmCard from './components/ConfirmCard';
import VisualCard from './components/VisualCard';
import { dropConfirm, pushConfirm, type ConfirmRequest } from './lib/confirm';
import { isModalOpen } from './lib/modalState';
import { useJarvisMode } from './hooks/useJarvisMode';
import { useVoiceAgent } from './hooks/useVoiceAgent';
import { useSubtitles } from './hooks/useSubtitles';
import { useMode } from './hooks/useMode';
import type { NotifyPayload } from './lib/protocol';
import type { LogEntry } from './lib/jarvisMode';
import './index.css';

const LOG_LIMIT = 6;
let lastSay = 0;

const cleanError = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function App() {
  const [version, setVersion] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [mini, setMini] = useState(false);
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
        const reply = await window.electronAPI.ai.chat(
          cmd,
          (d: string) => live && turnRef.current === my && subtitles.push(d),
          (n: string) => live && turnRef.current === my && subtitles.progress(n)
        );
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
        if (turnRef.current === my) setBusy(false);
      }
    },
    [subtitles]
  );

  const speak = useCallback(
    (text: string) => {
      subtitles.begin();
      subtitles.push(text);
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
    const offRequest = window.electronAPI.on('confirm-request', (r) => {
      const req = r as ConfirmRequest;
      pushConfirm(req);
      // Approval prompts are spoken in BOTH modes: safety is above silence.
      speakRef.current(`${req.title} Say yes or no.`);
    });
    const offClear = window.electronAPI.on('confirm-clear', (id) => dropConfirm(Number(id)));
    return () => {
      offRequest();
      offClear();
    };
  }, []);

  // The background-mode end-of-task notification: the ONE voice a silent turn gets,
  // speaking the turn's real verdict (reply, honest failure or interruption).
  useEffect(() => {
    const off = window.electronAPI.on('jarvis-notify', (p) => {
      const n = p as NotifyPayload;
      if (!n || typeof n.speakLine !== 'string' || !n.speakLine) return;
      speakRef.current(n.speakLine);
    });
    return off;
  }, []);

  const voice = useVoiceAgent({ onCommand: handleCommand, onInterrupt: subtitles.stop, onCancel: cancelTurn, speak, busy });
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
    >
      <VoiceInput live={voice.live} mode={voice.mode} hint={voice.hint} onToggle={voice.toggle} />
      <TextCommand onSubmit={handleCommand} busy={busy} compact={mini} />
      <ConfirmCard />
      <VisualCard />
    </JarvisWindow>
  );
}
