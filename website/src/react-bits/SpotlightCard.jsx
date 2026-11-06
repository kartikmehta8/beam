// Adapted from React Bits SpotlightCard, local pointer light only.
import { useEffect, useRef } from "react";
import "./SpotlightCard.css";

export default function SpotlightCard({ children, className, motion, ...props }) {
  const rootRef = useRef(null);
  useEffect(() => {
    if (!motion) delete rootRef.current.dataset.spotlight;
  }, [motion]);

  const move = (event) => {
    if (!motion || !["mouse", "pen"].includes(event.pointerType)) return;
    const card = event.currentTarget;
    const bounds = card.getBoundingClientRect();
    card.style.setProperty("--spotlight-x", `${event.clientX - bounds.left}px`);
    card.style.setProperty("--spotlight-y", `${event.clientY - bounds.top}px`);
    card.dataset.spotlight = "active";
  };
  const leave = (event) => {
    delete event.currentTarget.dataset.spotlight;
  };
  return (
    <div
      {...props}
      ref={rootRef}
      className={`spotlight-card ${className}`}
      data-spotlight-motion={motion ? "on" : "off"}
      onPointerMove={move}
      onPointerLeave={leave}
      onPointerCancel={leave}
    >
      <span className="spotlight-card__light" aria-hidden="true" />
      {children}
    </div>
  );
}
