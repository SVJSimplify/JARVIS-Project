import { AnimatePresence, motion } from 'framer-motion';

export interface Caption {
  text: string;
  tone: 'speech' | 'error';
}

export default function Subtitles({ caption }: { caption: Caption | null }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-36 items-end justify-center px-8 pb-5" aria-live="polite">
      <div
        className={`absolute inset-0 bg-gradient-to-t from-[rgb(var(--void)/0.85)] to-transparent transition-opacity duration-300 ${
          caption ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <AnimatePresence mode="wait" initial={false}>
        {caption && (
          <motion.p
            key={caption.text}
            className={`relative max-w-[44rem] text-center text-[26px] font-medium leading-tight tracking-wide [text-shadow:0_2px_12px_rgb(0_0_0/0.9)] ${
              caption.tone === 'error' ? 'text-amber-300' : 'text-hot'
            }`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            {caption.text}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
