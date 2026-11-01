import { motion } from 'framer-motion';
import type { JarvisMode } from '../lib/jarvisMode';

interface Props {
  live: boolean;
  mode: JarvisMode;
  hint: string;
  onToggle: () => void;
}

export default function VoiceInput({ live, mode, hint, onToggle }: Props) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="h-5 text-sm text-steel">{hint}</div>

      <button
        type="button"
        onClick={onToggle}
        className="mic"
        aria-label={live ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={live}
      >
        <svg className="mic-ticks" viewBox="0 0 102 102" aria-hidden="true">
          <circle cx="51" cy="51" r="50" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeDasharray="1 5" />
        </svg>
        {live && mode === 'listening' && (
          <motion.span
            className="mic-ripple"
            initial={{ scale: 1, opacity: 0.5 }}
            animate={{ scale: 1.7, opacity: 0 }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <MicGlyph live={live} mode={mode} />
      </button>
    </div>
  );
}

function MicGlyph({ live, mode }: { live: boolean; mode: JarvisMode }) {
  const common = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const };
  if (mode === 'thinking') {
    return (
      <motion.svg {...common} animate={{ rotate: 360 }} transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}>
        <path d="M12 4a8 8 0 1 1-8 8" />
      </motion.svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {!live && <path d="M4 4l16 16" />}
    </svg>
  );
}
