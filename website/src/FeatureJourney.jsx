import { useEffect, useRef, useState } from "react";
import "./journey.css";

const TITLES = [
  "Pay in place",
  "Check the signals",
  "Use a name",
  "Confirm as a human",
];
const DESKTOP =
  "(min-width: 1000px) and (min-height: 650px) and (hover: hover) and (pointer: fine)";

function PayScene({ Icon, Mark }) {
  const [review, setReview] = useState(false);
  return (
    <div className="journey-pay-scene">
      <div className="journey-chat">
        <span className="avatar">P</span>
        <div>
          <b>Priya</b>
          <p>Coffee was a good call.</p>
          <p>
            Your half is 0.0085 ETH.
            <br />
            maya.eth · testnet
          </p>
        </div>
      </div>
      <div className={`journey-payment ${review ? "is-reviewed" : ""}`}>
        <div className="journey-payment-top">
          <Mark />
          <span>{review ? "Ready for your review" : "Beam is right here"}</span>
          <span className="testnet">Testnet</span>
        </div>
        <div className="journey-amount">
          0.0085 <span>ETH</span>
        </div>
        <p>
          {review
            ? "to maya.eth · Coffee, covered."
            : "The details are already in the conversation."}
        </p>
        {review && (
          <span className="risk-label safe">
            <Icon name="shield-check" /> Looks safe · sample
          </span>
        )}
        <button className="button" onClick={() => setReview(!review)}>
          <Icon name={review ? "refresh" : "scan"} />
          {review ? "Back to the message" : "Read this sample"}
        </button>
      </div>
      <span className="journey-scene-note">
        Illustrative payment · no funds sent
      </span>
    </div>
  );
}

function CheckScene({ Icon }) {
  const [trap, setTrap] = useState(false);
  return (
    <div className={`journey-check-scene ${trap ? "danger" : "safe"}`}>
      <div className="journey-message">
        <Icon name="message-circle" />
        <p>
          {trap
            ? "Pay a processing fee to receive your refund. Share your recovery phrase to verify."
            : "Your half is 0.0085 ETH for coffee. Send to maya.eth on testnet?"}
        </p>
      </div>
      <div className="journey-risk">
        <Icon name={trap ? "shield-x" : "shield-check"} />
        <strong>{trap ? "Likely scam" : "Looks safe"}</strong>
      </div>
      <p className="journey-risk-reason">
        {trap
          ? "Asks for a secret. Asks you to pay to receive."
          : "No common warning signs in this sample. Still check every detail."}
      </p>
      <button className="button secondary" onClick={() => setTrap(!trap)}>
        {trap ? "Try the coffee message" : "Try a refund trap"}
        <Icon name="arrows-exchange" />
      </button>
      <span className="journey-scene-note">
        Sample verdict · risk signals are not a guarantee
      </span>
    </div>
  );
}

function NameScene({ Icon, Mark }) {
  const [resolved, setResolved] = useState(false);
  return (
    <div className={`journey-name-scene ${resolved ? "is-resolved" : ""}`}>
      <div className="journey-name-token">
        <Mark />
        <span>maya.eth</span>
        <Icon name="arrow-down" />
      </div>
      <div className="journey-address">
        <Icon name={resolved ? "circle-check" : "link"} />
        <span>{resolved ? "0x7a…9B2e" : "A name worth checking."}</span>
        <small>
          {resolved
            ? "Illustrative address · not a live lookup"
            : "Beam re-resolves ENS on your phone."}
        </small>
      </div>
      <span className="network-token">EVM testnet</span>
      <button className="text-button" onClick={() => setResolved(!resolved)}>
        {resolved ? "Show the name again" : "Show sample resolution"}
        <Icon name={resolved ? "refresh" : "arrow-up-right"} />
      </button>
    </div>
  );
}

function ApprovalScene({ Icon }) {
  const [approved, setApproved] = useState(false);
  return (
    <div className="journey-voice-scene">
      <span className="journey-world-mark"><img src="/assets/world.svg" alt="" width="42" height="42" /></span>
      <p>{approved ? "World ID approved." : "0.042 ETH needs World ID."}</p>
      <span>{approved ? "The phone still asks you to confirm." : "This exceeds the sample 0.025 ETH cap."}</span>
      <button className="button secondary" onClick={() => setApproved(!approved)}>
        <Icon name={approved ? "refresh" : "check"} />
        {approved ? "Reset example" : "Simulate approval"}
      </button>
      <small>Sample proof · no World App connection</small>
    </div>
  );
}

export default function FeatureJourney({ motion, Icon, Mark }) {
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState(false);
  const root = useRef(null),
    viewport = useRef(null),
    track = useRef(null),
    bar = useRef(null);
  const trigger = useRef(null),
    activeRef = useRef(0),
    restoring = useRef(false),
    drag = useRef(null),
    buttons = useRef([]);
  const maxTravel = () =>
    Math.max(0, track.current.scrollWidth - viewport.current.clientWidth);
  const offset = (index) =>
    Math.min(track.current.children[index].offsetLeft, maxTravel());
  const sync = (value) => {
    if (restoring.current) return;
    const distance = maxTravel();
    if (bar.current)
      bar.current.style.transform = `scaleX(${distance ? value / distance : 0})`;
    const next = TITLES.reduce(
      (best, _, i) =>
        Math.abs(offset(i) - value) < Math.abs(offset(best) - value) ? i : best,
      0,
    );
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActive(next);
    }
  };
  const goTo = (index, keyboard = false) => {
    const next = Math.max(0, Math.min(TITLES.length - 1, index));
    const behavior = motion && !keyboard ? "smooth" : "instant";
    if (trigger.current) {
      const st = trigger.current;
      window.scrollTo({
        top:
          st.start +
          (maxTravel() ? offset(next) / maxTravel() : 0) * (st.end - st.start),
        behavior,
      });
      st.update();
    } else {
      viewport.current.scrollTo({ left: offset(next), behavior });
    }
    if (!motion || keyboard) sync(offset(next));
  };

  useEffect(() => {
    let disposed = false,
      started = false,
      near = false,
      matchMedia,
      observer,
      restoreFrame;
    const query = window.matchMedia(DESKTOP);
    const restoreNative = () => {
      const selected = activeRef.current;
      restoring.current = true;
      setPinned(false);
      restoreFrame = requestAnimationFrame(() => {
        const left = offset(selected);
        viewport.current?.scrollTo({ left, behavior: "instant" });
        restoring.current = false;
        sync(left);
      });
    };
    restoreNative();
    const start = async () => {
      if (!motion || !near || !query.matches || started) return;
      started = true;
      try {
        const [{ gsap }, { ScrollTrigger }] = await Promise.all([
          import("gsap"),
          import("gsap/ScrollTrigger"),
        ]);
        if (disposed) return;
        gsap.registerPlugin(ScrollTrigger);
        matchMedia = gsap.matchMedia();
        matchMedia.add(
          DESKTOP,
          () => {
            if (disposed) return;
            viewport.current.scrollLeft = 0;
            setPinned(true);
            const tween = gsap.to(track.current, {
              x: () => -maxTravel(),
              ease: "none",
              scrollTrigger: {
                trigger: root.current,
                pin: true,
                start: "top 32px",
                end: () => `+=${maxTravel()}`,
                scrub: true,
                invalidateOnRefresh: true,
                anticipatePin: 1,
                onUpdate: (self) => sync(self.progress * maxTravel()),
                onRefresh: (self) => sync(self.progress * maxTravel()),
              },
            });
            trigger.current = tween.scrollTrigger;
            const transcript = document.querySelector(".demo-transcript");
            const refreshLayout = () => ScrollTrigger.refresh(true);
            transcript?.addEventListener("toggle", refreshLayout);
            document.fonts?.ready.then(() => {
              if (!disposed) ScrollTrigger.refresh();
            });
            return () => {
              transcript?.removeEventListener("toggle", refreshLayout);
              trigger.current = null;
              if (!disposed) restoreNative();
            };
          },
          root.current,
        );
      } catch {
        if (!disposed) setPinned(false);
      }
    };
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          near = true;
          start();
          observer.disconnect();
        }
      },
      { rootMargin: "350px" },
    );
    observer.observe(root.current);
    query.addEventListener("change", start);
    return () => {
      disposed = true;
      cancelAnimationFrame(restoreFrame);
      observer.disconnect();
      query.removeEventListener("change", start);
      restoring.current = true;
      matchMedia?.revert();
      trigger.current = null;
    };
  }, [motion]);

  const onKeyDown = (event) => {
    const delta = { ArrowRight: 1, ArrowLeft: -1 };
    let next;
    if (event.key in delta) next = activeRef.current + delta[event.key];
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = TITLES.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    next = Math.max(0, Math.min(TITLES.length - 1, next));
    goTo(next, true);
    buttons.current[next]?.focus({ preventScroll: true });
  };
  const onPointerDown = (event) => {
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      event.target.closest("button,a")
    )
      return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      left: viewport.current.scrollLeft,
      y: window.scrollY,
      moved: false,
    };
  };
  const onPointerMove = (event) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    const dx = event.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 6) return;
    if (!d.moved) {
      d.moved = true;
      viewport.current.setPointerCapture(d.id);
      viewport.current.dataset.dragging = "true";
    }
    event.preventDefault();
    if (trigger.current)
      window.scrollTo({ top: d.y - dx, behavior: "instant" });
    else viewport.current.scrollLeft = d.left - dx;
  };
  const endDrag = (event) => {
    if (
      drag.current?.moved &&
      viewport.current.hasPointerCapture(event.pointerId)
    )
      viewport.current.releasePointerCapture(event.pointerId);
    drag.current = null;
    delete viewport.current.dataset.dragging;
  };

  const scenes = [PayScene, CheckScene, NameScene, ApprovalScene];
  const headings = [
    <>
      Keep the chat.
      <br />
      Lose the app shuffle.
    </>,
    <>
      Good instinct.
      <br />
      Get a second opinion.
    </>,
    <>
      Less hex.
      <br />
      More human.
    </>,
    <>
      A second check.
      <br />
      A real person.
    </>,
  ];
  const copy = [
    "A message already has the amount and recipient. Tap Beam, read the details and review the payment on your phone.",
    "Compare a coffee split with a refund trap. Scam Shield explains the signals, so you can make the call.",
    "Pay an ENS name you can read. Beam resolves it on Ethereum, then checks it again on your phone for the EVM testnet payment.",
    "World ID adds a human approval step for over-cap and external-agent requests. The wallet still needs your confirmation on the phone.",
  ];
  return (
    <div
      ref={root}
      className={`journey ${pinned && motion ? "is-pinned" : ""}`}
      data-mode={pinned && motion ? "scroll" : "native"}
      data-motion={motion ? "on" : "off"}
      onKeyDownCapture={() => (root.current.dataset.input = "keyboard")}
      onPointerDownCapture={() => (root.current.dataset.input = "pointer")}
      role="region"
      aria-roledescription="carousel"
      aria-label="Explore Beam features"
      onKeyDown={onKeyDown}
    >
      <div className="journey-toolbar">
        <p>
          <Icon name={pinned ? "arrow-down" : "arrows-horizontal"} />
          {pinned
            ? "Scroll down. See what comes around."
            : "Swipe, drag, or use the arrows."}
        </p>
        <div>
          <button
            className="icon-button"
            aria-label="Previous feature"
            disabled={active === 0}
            onClick={(e) => goTo(active - 1, e.detail === 0)}
          >
            <Icon name="arrow-left" />
          </button>
          <button
            className="icon-button"
            aria-label="Next feature"
            disabled={active === 3}
            onClick={(e) => goTo(active + 1, e.detail === 0)}
          >
            <Icon name="arrow-right" />
          </button>
        </div>
      </div>
      <div
        className="journey-viewport"
        ref={viewport}
        tabIndex={0}
        aria-label="Feature panels. Use left and right arrows to explore."
        onScroll={(e) => {
          if (!trigger.current) sync(e.currentTarget.scrollLeft);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          if (drag.current && !drag.current.moved) drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          delete viewport.current.dataset.dragging;
        }}
      >
        <div className="journey-track" ref={track}>
          {TITLES.map((title, i) => {
            const Scene = scenes[i];
            return (
              <article
                className={`journey-panel journey-panel-${i}`}
                key={title}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of 4: ${title}`}
                aria-hidden={active !== i}
                inert={active !== i}
                id={`feature-panel-${i}`}
              >
                <div className="journey-copy">
                  <h3>{headings[i]}</h3>
                  <p>{copy[i]}</p>
                  <a
                    className="text-link"
                    href={
                      i === 1
                        ? "#scam-shield"
                        : i === 3
                          ? "#agents"
                          : "#playground"
                    }
                  >
                    {
                      [
                        "Try the payment demo",
                        "Explore Scam Shield",
                        "Try a sample payment",
                        "Explore agent requests",
                      ][i]
                    }
                    <Icon name="arrow-up-right" />
                  </a>
                </div>
                <div className="journey-scene">
                  <Scene Icon={Icon} Mark={Mark} />
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <div className="journey-bottom">
        <div className="journey-nav" aria-label="Choose a feature">
          {TITLES.map((name, i) => (
            <button
              key={name}
              ref={(el) => (buttons.current[i] = el)}
              aria-pressed={active === i}
              aria-controls={`feature-panel-${i}`}
              onClick={(e) => goTo(i, e.detail === 0)}
            >
              <span aria-hidden="true" />
              {["Pay", "Check", "Resolve", "Approve"][i]}
            </button>
          ))}
        </div>
        <span className="journey-count" role="status" aria-live="polite">
          {active + 1} / 4
        </span>
      </div>
      <div className="journey-progress" aria-hidden="true">
        <span ref={bar} />
      </div>
    </div>
  );
}
