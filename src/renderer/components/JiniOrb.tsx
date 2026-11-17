import { useEffect, useRef, type MutableRefObject } from 'react';
import type { JarvisMode } from '../lib/jarvisMode';

/**
 * JINI's presence: a calm lavender orb. State is shown by its ring (listening / thinking /
 * speaking) and by a subtle scale that follows the live microphone level. The level is read
 * from a ref on each animation frame, so voice activity never re-renders React.
 */
export default function JiniOrb({ mode, levelRef, size = 72 }: { mode: JarvisMode; levelRef: MutableRefObject<number>; size?: number }) {
  const core = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== 'listening' && mode !== 'speaking') {
      if (core.current) core.current.style.transform = '';
      return;
    }
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const lvl = Math.min(1, Math.max(0, levelRef.current || 0));
      smooth += (lvl - smooth) * 0.25;
      if (core.current) core.current.style.transform = `scale(${1 + smooth * 0.12})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, levelRef]);

  return (
    <div className="orb" data-state={mode} data-small={size < 40} style={{ width: size, height: size, fontSize: size / 4 }} role="img" aria-label={`JINI is ${mode === 'idle' ? 'ready' : mode}`}>
      <span className="orb-ring" />
      <div ref={core} className="orb-core" />
    </div>
  );
}
