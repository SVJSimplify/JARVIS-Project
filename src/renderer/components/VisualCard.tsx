import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { HOLO_CSS } from '../lib/holoKit';
import { popModal, pushModal } from '../lib/modalState';

export interface Visual {
  title: string;
  html: string;
  /** The HUD was mini before the visual took the screen; closing the visual returns it there. */
  restoreMini?: boolean;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:";
const frameDoc = (html: string) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${HOLO_CSS}</style>${html}`;

/** Projects what JARVIS draws via show_visual as a holographic panel. Sandboxed: scripts run, network and parent access do not. */
export default function VisualCard() {
  const [visual, setVisual] = useState<Visual | null>(null);
  /** Any HUD mini/full change after the visual arrived means the user moved things themselves. */
  const hudTouched = useRef(false);

  useEffect(() => window.electronAPI.on('jarvis-visual', (v) => {
    hudTouched.current = false;
    setVisual(v as Visual);
  }), []);

  useEffect(() => window.electronAPI.hud.onMini(() => {
    hudTouched.current = true;
  }), []);

  const close = useCallback((): void => {
    // Restore mini only when the visual itself docked the HUD and the user has not expanded or
    // shrunk it since: an explicit user action must never be silently reverted on close.
    if (visual?.restoreMini && !hudTouched.current) void window.electronAPI.hud.setMini(true);
    setVisual(null);
  }, [visual]);

  useEffect(() => {
    if (!visual) return;
    pushModal();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => {
      popModal();
      window.removeEventListener('keydown', onKey);
    };
  }, [visual, close]);

  return (
    <AnimatePresence>
      {visual && (
        <motion.section
          key={visual.html}
          className="holo-panel no-drag fixed inset-x-0 bottom-28 top-14 z-30 mx-auto flex flex-col overflow-hidden"
          style={{ width: 'min(1100px, calc(100% - 48px))' }}
          initial={{ opacity: 0, scaleY: 0.04, scaleX: 0.97 }}
          animate={{ opacity: 1, scaleY: 1, scaleX: 1 }}
          exit={{ opacity: 0, scaleY: 0.04 }}
          transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <div className="holo-grid" />
          <span className="holo-br holo-br-tl" />
          <span className="holo-br holo-br-tr" />
          <span className="holo-br holo-br-bl" />
          <span className="holo-br holo-br-br" />
          <header className="relative z-[3] flex shrink-0 items-center justify-between px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="holo-dot" />
              <h2 className="holo-title">{visual.title}</h2>
            </div>
            <button type="button" onClick={close} aria-label="Close visual" className="holo-close">
              ✕
            </button>
          </header>
          <div className="holo-rule" />
          <iframe title={visual.title} sandbox="allow-scripts" srcDoc={frameDoc(visual.html)} className="relative z-[1] min-h-0 w-full flex-1 border-0" />
          <div className="holo-sweep" />
          <div className="holo-flash" />
        </motion.section>
      )}
    </AnimatePresence>
  );
}
