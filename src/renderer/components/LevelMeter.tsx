import { useEffect, useRef, type MutableRefObject } from 'react';

export default function LevelMeter({ levelRef }: { levelRef: MutableRefObject<number> }) {
  const fill = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (fill.current) fill.current.style.transform = `scaleX(${levelRef.current})`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  return (
    <div className="meter" role="presentation">
      <div ref={fill} className="meter-fill" />
    </div>
  );
}
