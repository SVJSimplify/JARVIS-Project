import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { visualFrameDoc } from '../lib/holoKit';
import { normalizeVisual, renderVisual } from '../lib/visualIR';
import { popModal, pushModal } from '../lib/modalState';

export interface Visual {
  id: number;
  title: string;
  subtitle?: string;
  /** Structured content (preferred): rendered by visualIR with deterministic components. */
  blocks?: unknown;
  /** Legacy raw markup path: sanitised in the main process, CSP-strapped in the frame. */
  html?: string;
  /** The HUD was mini before the visual took the screen; closing the visual returns it there. */
  restoreMini?: boolean;
}

/** Minimal escaping for the emergency frame below — the only string ops on that path. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Last-resort frame, used ONLY if the repair/render layer itself ever throws. Built with
 * plain string concatenation of escaped text — no IR, no JSON, no dynamic components —
 * and null-safe down to the last expression, because this code runs where everything
 * else has already failed.
 */
const emergencyDoc = (v: Visual | null | undefined): string => {
  const title = typeof v?.title === 'string' ? v.title : '';
  const subtitle = typeof v?.subtitle === 'string' ? v.subtitle : '';
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:26px;background:#FFFDF9;color:#bfe9ff;font:15px/1.65 sans-serif}` +
    `h1{font-size:19px;margin:0 0 10px;font-weight:600}p{margin:0 0 6px}` +
    `.m{margin-top:14px;opacity:.65;font-size:13px}</style></head><body>` +
    `<h1>${esc(title)}</h1>` +
    (subtitle ? `<p>${esc(subtitle)}</p>` : '') +
    `<p class="m">Part of this visual could not be processed, sir — ask me to build it again and I will use a simpler layout.</p>` +
    `</body></html>`
  );
};

/** An ipc push must at least carry a usable title before it may reach the render path. */
export const isRenderableVisual = (v: unknown): v is Visual =>
  !!v && typeof v === 'object' && typeof (v as Visual).title === 'string' && (v as Visual).title.trim().length > 0;

/**
 * The visual's body. GUARANTEE: this NEVER returns a dead-end "could not be built" panel
 * and it NEVER throws. normalizeVisual repairs any payload into at least one renderable
 * block (visualIR.ts); a visual with neither blocks nor markup renders its own heading as
 * a note; and should the repair layer itself ever throw on a pathological payload, the
 * catch-all net degrades to emergencyDoc — the render path is surrounded on every side.
 */
export const bodyFor = (v: Visual): string => {
  try {
    if (!v || typeof v !== 'object') return emergencyDoc(v); // a null push renders the calm frame, never a crash
    if (v.blocks != null) {
      const { ir } = normalizeVisual(v.blocks);
      return visualFrameDoc(renderVisual(ir));
    }
    if (v.html) return visualFrameDoc(v.html);
    const { ir } = normalizeVisual({
      blocks: [{ type: 'note', tone: 'warn', title: v.title, text: v.subtitle || 'This visual arrived without content. Ask JINI to build it again.' }],
    });
    return visualFrameDoc(renderVisual(ir));
  } catch {
    // Unreachable by contract; kept as the absolute last line of defence. A throw here
    // would unmount the whole HUD (React error boundaries did not always exist).
    return emergencyDoc(v);
  }
};

/** Projects what JARVIS draws via show_visual as a holographic panel. Sandboxed: content is data — no scripts, no network, no parent access. */
export default function VisualCard() {
  const [visual, setVisual] = useState<Visual | null>(null);
  /** Any HUD mini/full change after the visual arrived means the user moved things themselves. */
  const hudTouched = useRef(false);

  useEffect(() => window.electronAPI.on('jarvis-visual', (v) => {
    // Boundary discipline, same as jarvis-notify: a malformed push is dropped at the door
    // instead of being rendered and hoping the shapes line up.
    if (!isRenderableVisual(v)) return;
    hudTouched.current = false;
    setVisual(v);
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

  // Built once per visual, not on every parent re-render: bodyFor walks the whole IR.
  const doc = useMemo(() => bodyFor(visual), [visual]);

  return (
    <AnimatePresence>
      {visual && (
        <motion.section
          key={visual.id}
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
            <div className="flex min-w-0 items-center gap-3">
              <span className="holo-dot shrink-0" />
              <div className="min-w-0">
                <h2 className="holo-title truncate">{visual.title}</h2>
                {visual.subtitle && <p className="holo-subtitle truncate">{visual.subtitle}</p>}
              </div>
            </div>
            <button type="button" onClick={close} aria-label="Close visual" className="holo-close shrink-0 pl-3">
              ✕
            </button>
          </header>
          <div className="holo-rule" />
          <iframe title={visual.title} sandbox="" srcDoc={doc} className="relative z-[1] min-h-0 w-full flex-1 border-0" />
          <div className="holo-sweep" />
          <div className="holo-flash" />
        </motion.section>
      )}
    </AnimatePresence>
  );
}
