import { useCallback, useEffect, useRef, useState } from "react";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { getState, setState, type ChatMessage } from "../lib/store";
import { sendText } from "../screens/Chat";

type Phase = "starting" | "listening" | "thinking" | "speaking" | "error";

const STOP =
  /^\s*(?:stop|cancel|never ?mind|enough|stop it|stop that)[\s.!]*$/i;
const BYE = /^\s*(?:bye|goodbye|end (?:voice|call)|that'?s all|exit)[\s.!]*$/i;

/** Plain speakable text: no markdown, links or code, and not a novel. */
const speakable = (t: string): string =>
  t
    .replace(/```[\s\S]*?```/g, " (code shown in chat) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1400);

/** Wait for a reply message to finish (desktop replies arrive through sync). */
function waitForReply(
  replyId: string,
  cancelled: () => boolean,
  timeoutMs = 240_000,
): Promise<ChatMessage | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (cancelled()) return resolve(null);
      const m = getState().messages.find((x) => x.id === replyId);
      if (m && (m.state === "done" || m.state === "failed")) return resolve(m);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

/**
 * Full-screen voice conversation, like ChatGPT / Claude voice mode: listen → think → speak →
 * listen again, hands-free. Tap the orb to interrupt JINI mid-sentence (or to stop it
 * thinking); say "stop" to cancel; say "bye" or press End to leave. Every exchange is
 * also written to the current chat, so nothing said by voice is lost.
 */
export default function VoiceMode({
  kind,
  onClose,
}: {
  kind: ChatMessage["kind"];
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const turn = useRef(0); // bumping it abandons whatever the current exchange was waiting on
  const partial = useRef("");
  const listening = useRef(false); // one recognizer session at a time
  const captureId = useRef(0);
  const finishedCapture = useRef(0);
  const finishCapture = useRef<() => void>(() => undefined);

  const speak = useCallback(async (text: string) => {
    if (!alive.current || !text) return;
    setPhase("speaking");
    setSaid(text);
    try {
      await TextToSpeech.speak({
        text: speakable(text),
        lang: "en-US",
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
        category: "playback",
      });
    } catch {
      /* interrupted or no TTS engine — carry on listening */
    }
  }, []);

  const listen = useCallback(async () => {
    if (!alive.current || listening.current) return;
    listening.current = true;
    const id = ++captureId.current;
    partial.current = "";
    setHeard("");
    setPhase("listening");
    finishCapture.current = () => {
      if (finishedCapture.current === id) return;
      finishedCapture.current = id;
      listening.current = false;
      if (alive.current) void handle(partial.current);
    };
    try {
      await SpeechRecognition.start({
        language: "en-IN",
        partialResults: true,
        popup: false,
        maxResults: 1,
      });
    } catch (e) {
      // "No match" / silence ends a listen without a result: just listen again.
      listening.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      if (!alive.current) return;
      if (/no match|didn'?t understand|timeout|no speech|recognizer busy|already listening/i.test(msg))
        return void setTimeout(() => void listen(), 450);
      setError(msg);
      setPhase("error");
    }
  }, []);

  const handle = useCallback(
    async (text: string) => {
      const my = ++turn.current;
      const t = text.trim();
      if (!t) return void listen();
      if (BYE.test(t)) return onClose();
      if (STOP.test(t)) {
        await sendText("stop", "chat").catch(() => null);
        await speak("Stopped.");
        return void listen();
      }
      setPhase("thinking");
      setSaid("");
      const replyId = await sendText(t, kind);
      if (!replyId) {
        await speak(
          "I need a paired desktop or an AI provider in Settings first.",
        );
        return onClose();
      }
      const reply = await waitForReply(
        replyId,
        () => !alive.current || turn.current !== my,
      );
      if (!alive.current || turn.current !== my) return;
      if (!reply)
        await speak(
          "That's taking a while. I'll keep working — the answer will be in the chat.",
        );
      else
        await speak(
          reply.state === "failed"
            ? `Sorry, that didn't work. ${reply.text}`
            : reply.text,
        );
      if (alive.current && turn.current === my) void listen();
    },
    [kind, listen, onClose, speak],
  );

  // Start: permissions, listeners, first listen. Leaving stops everything.
  useEffect(() => {
    alive.current = true;
    const subs: Array<Promise<{ remove: () => Promise<void> }>> = [];
    void (async () => {
      try {
        const { available } = await SpeechRecognition.available();
        if (!available)
          throw new Error(
            "Speech recognition is not available on this phone. Install or enable the Google speech service.",
          );
        const perm = await SpeechRecognition.requestPermissions();
        if (perm.speechRecognition !== "granted")
          throw new Error("Microphone permission is needed for voice mode.");
        // Capacitor listener registration is asynchronous. Await both listeners before
        // starting recognition or the first stopped/final event can be lost.
        const partialListener = await SpeechRecognition.addListener("partialResults", (d) => {
          const next = d.matches?.[0]?.trim();
          if (next) {
            partial.current = next;
            setHeard(next);
          }
        });
        subs.push(Promise.resolve(partialListener));
        const stateListener = await SpeechRecognition.addListener("listeningState", (d) => {
          if (d.status === "stopped" && alive.current) finishCapture.current();
        });
        subs.push(Promise.resolve(stateListener));
        void listen();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    const turnRef = turn;
    return () => {
      alive.current = false;
      turnRef.current++;
      listening.current = false;
      void SpeechRecognition.stop().catch(() => undefined);
      void TextToSpeech.stop().catch(() => undefined);
      void Promise.all(subs).then((h) => h.forEach((x) => void x.remove()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The orb: interrupt speech, abandon a long think, or end a listen early. */
  const tapOrb = async () => {
    if (phase === "speaking") {
      turn.current++;
      await TextToSpeech.stop().catch(() => undefined);
      void listen();
    } else if (phase === "thinking") {
      turn.current++;
      void sendText("stop", "chat");
      void listen();
    } else if (phase === "listening") {
      await SpeechRecognition.stop().catch(() => undefined);
    } else if (phase === "error") {
      setError("");
      void listen();
    }
  };

  const label = {
    starting: "Starting…",
    listening: heard ? "Listening" : "Go ahead, I’m listening",
    thinking: "Thinking…",
    speaking: "Tap to interrupt",
    error: "Voice unavailable",
  }[phase];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-bg px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(3rem,env(safe-area-inset-top))]"
      role="dialog"
      aria-label="Voice mode"
    >
      <p className="text-meta font-medium text-muted">
        {kind === "task" ? "Voice · runs on desktop" : "Voice"}
      </p>

      <div className="flex flex-col items-center gap-8">
        <button
          onClick={() => void tapOrb()}
          aria-label={label}
          className={`voice-orb voice-orb--${phase}`}
        >
          <span className="voice-orb__core" />
        </button>
        <p
          className="text-[15px] font-medium text-text"
          role="status"
          aria-live="polite"
        >
          {label}
        </p>
        <p className="min-h-[3.5rem] max-w-[22rem] text-center text-body text-muted">
          {phase === "error"
            ? error
            : phase === "speaking"
              ? said.slice(0, 220)
              : heard}
        </p>
      </div>

      <button
        onClick={() => {
          setState({ toast: "" });
          onClose();
        }}
        className="h-12 w-40 rounded-full bg-ink text-[15px] font-medium text-paper active:bg-black"
      >
        End
      </button>
    </div>
  );
}
