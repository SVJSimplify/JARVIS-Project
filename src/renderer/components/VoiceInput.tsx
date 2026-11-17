import { motion } from 'framer-motion';
import type { JarvisMode } from '../lib/jarvisMode';

interface Props {
  live: boolean;
  mode: JarvisMode;
  hint: string;
  onToggle: () => void;
  compact?: boolean;
}

/** Microphone toggle for the composer toolbar, with the voice engine's status beside it. */
export default function VoiceInput({ live, mode, hint, onToggle, compact }: Props) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <button
        type="button"
        onClick={onToggle}
        className="mic"
        aria-label={live ? 'Mute microphone' : 'Turn on microphone'}
        aria-pressed={live}
        title={live ? 'Listening — click to mute' : 'Microphone off — click to talk to JINI'}
      >
        {live && mode === 'listening' && (
          <motion.span className="mic-ripple" initial={{ scale: 1, opacity: 0.6 }} animate={{ scale: 1.5, opacity: 0 }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeOut' }} />
        )}
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          {!live && <path d="M4 4l16 16" />}
        </svg>
      </button>
      {!compact && hint && (
        <span className="truncate text-[12.5px] text-faint" role="status">
          {hint}
        </span>
      )}
    </div>
  );
}
