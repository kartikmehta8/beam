// Adapted from React Bits CountUp, count mode. See PROVENANCE.json and LICENSE.md.
import { useLayoutEffect, useRef } from "react";

export default function CountUp({ to, motion, decimals = 4 }) {
  const textRef = useRef(null);
  const current = useRef(to);

  useLayoutEffect(() => {
    const text = textRef.current;
    const from = current.current;
    const paint = (value) => {
      current.current = value;
      text.textContent = value.toFixed(decimals);
    };
    if (!motion || from === to) {
      paint(to);
      return;
    }

    paint(from);
    let frame;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, Math.max(0, (now - start) / 260));
      if (progress === 1) {
        paint(to);
        return;
      }
      const eased = 1 - (1 - progress) ** 3;
      paint(from + (to - from) * eased);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, motion, decimals]);

  return <span ref={textRef} className="count-up" aria-hidden="true">{to.toFixed(decimals)}</span>;
}
