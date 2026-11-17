import { useCallback, useEffect, useRef, useState } from 'react';
import { startListener } from '../lib/listener';
import { loadWhisper, transcribe } from '../lib/whisper';
import { isSpeaking } from '../lib/speech';
import { cleanTranscript, greeting, isStop, parseWake } from '../lib/transcript';
import { setVoicePrefs, useVoicePrefs } from '../lib/voicePrefs';
import { ENROL_CLIPS, addClip, hasPrint, isEnrolling, startEnrol, useVoiceprint, verify } from '../lib/voiceprint';
import type { JarvisMode } from '../lib/jarvisMode';

const NOISE = /^\W*(thank(s| you)( for watching)?|you|uh+|um+|hm+|mm+|ah+|oh+|bye|\[.*\]|\(.*\))?\W*$/i;

interface Options {
  onCommand: (text: string) => void;
  onCancel: () => void;
  speak: (text: string) => void;
  busy: boolean;
}

export function useVoiceAgent(o: Options) {
  const prefs = useVoicePrefs();
  const vp = useVoiceprint();
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const [live, setLive] = useState(true);
  const [modelError, setModelError] = useState('');
  const [micError, setMicError] = useState('');
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [talking, setTalking] = useState(false);
  const [transcribing, setTranscribing] = useState(0);

  const levelRef = useRef(0);
  const liveRef = useRef(true);
  liveRef.current = live;
  const greeted = useRef(false);
  const latest = useRef({ prefs, o });
  latest.current = { prefs, o };

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 2500);
  }, []);

  const handle = useCallback(
    async (audio: Float32Array, wasBarge = false) => {
      setTranscribing((n) => n + 1);
      try {
        const { prefs: p, o: cb } = latest.current;
        if (isEnrolling()) {
          const r = addClip(audio);
          if (r === 'short') flash('Too short. Say a full sentence.');
          if (r === 'done') {
            setVoicePrefs({ voiceLock: true });
            cb.speak('Voice profile saved. Voice lock is on.');
          }
          return;
        }
        if (p.voiceLock && (!hasPrint() || !verify(audio, p.lockStrictness))) return flash(hasPrint() ? 'Voice not recognised' : 'Voice setup needed');
        const text = cleanTranscript(await transcribe(audio));
        if (!text || NOISE.test(text) || !liveRef.current) return;
        const { woke, command } = parseWake(text);
        if (woke && !command) return cb.speak('Yes?');
        if (isStop(command)) return cb.onCancel(); // "stop" silences JARVIS and cancels the running request
        // While JARVIS is talking, only a wake-word command may interrupt: ambient noise,
        // the echo of JARVIS's own voice off the speakers and stray chatter are dropped
        // here, so a long answer is never cut off mid-sentence by a sound that was never
        // a command. The interrupt decision happens AFTER the utterance ends and the voice
        // has been verified — never at first detection.
        if (wasBarge && !woke) return;
        if (cb.busy && !woke) return; // while working, only "Jarvis, ..." interrupts (stray speech is ignored)
        cb.onCommand(command); // a new spoken command interrupts whatever JARVIS is doing
      } catch (e) {
        console.warn('Transcription failed:', e);
      } finally {
        setTranscribing((n) => n - 1);
      }
    },
    [flash]
  );

  // Load the speech model.
  useEffect(() => {
    let dead = false;
    loadWhisper((p) => !dead && setProgress(p))
      .then(() => !dead && setReady(true))
      .catch((e) => !dead && setModelError(`Voice model failed: ${e instanceof Error ? e.message : e}`));
    return () => {
      dead = true;
    };
  }, []);

  // Always-on microphone. Only a microphone failure blocks it, and muting/unmuting clears it,
  // so a transient failure (busy device at boot) can always be retried from the mic button.
  const micFailed = Boolean(micError);
  useEffect(() => {
    if (!live || micFailed) return;
    let dead = false;
    let stop: (() => void) | undefined;
    startListener({
      gate: () => (isSpeaking() ? (latest.current.prefs.interrupt ? 'barge' : 'deaf') : 'normal'),
      onLevel: (v) => (levelRef.current = v),
      // A barge capture no longer kills JARVIS's speech at detection time — that was the
      // cut-off bug: any sound louder than the barge threshold (speaker echo, a door, a
      // keyboard) silenced the rest of the answer before anyone knew who spoke. The audio
      // is captured, verified and transcribed first; only a real command acts on it.
      onStart: () => setTalking(true),
      onEnd: (audio, barge) => {
        setTalking(false);
        if (audio) void handle(audio, barge);
      },
    })
      .then((s) => (dead ? s.stop() : (stop = s.stop)))
      .catch((e) => !dead && setMicError(`Microphone unavailable: ${e instanceof Error ? e.message : e}`));
    return () => {
      dead = true;
      stop?.();
      levelRef.current = 0;
      setTalking(false);
    };
  }, [live, micFailed, handle]);

  // Boot greeting.
  useEffect(() => {
    const t = setTimeout(() => {
      if (greeted.current) return;
      greeted.current = true;
      if (!hasPrint()) {
        startEnrol();
        latest.current.o.speak('Sir, say five sentences so I learn your voice.');
      } else if (latest.current.prefs.greeting) latest.current.o.speak(greeting());
    }, 900);
    return () => clearTimeout(t);
  }, []);

  const toggle = useCallback(() => {
    setMicError(''); // a retry must be possible: a one-time failure used to brick the mic toggle for the whole session
    setLive((v) => !v);
  }, []);

  const mode: JarvisMode = talking ? 'listening' : transcribing > 0 ? 'thinking' : 'idle';

  const hint = notice
    ? notice
    : !live
    ? 'Microphone muted'
    : micError
    ? micError
    : modelError
    ? modelError
    : vp.clips !== null
    ? `Voice setup ${vp.clips + 1}/${ENROL_CLIPS}: say any sentence`
    : !ready
      ? `Loading voice model${progress ? ` ${progress}%` : '…'}`
      : talking
        ? 'Listening…'
        : transcribing > 0
          ? 'Transcribing…'
          : 'Listening…';

  return { mode, hint, levelRef, live, toggle, ready };
}
