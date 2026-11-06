import { useEffect, useRef, useState } from "react";
import SpotlightCard from "./react-bits/SpotlightCard.jsx";
import "./preview.css";

const frames = [
  {
    title: "Pay from the screen you’re on.",
    caption: "Tap the floating Beam while the payment details are visible.",
    label: "Capture",
    detail: "Coffee was 0.0085 ETH. Send it to maya.eth?",
    icon: "scan",
    partner: "ens",
  },
  {
    title: "See where it goes.",
    caption: "Beam resolves the ENS name and shows the amount and recipient for review.",
    label: "Review payment",
    detail: "0.0085 ETH to maya.eth",
    icon: "list-details",
    partner: "ens",
  },
  {
    title: "Some requests need World ID.",
    caption: "A 0.042 ETH sample exceeds the per-payment cap. World ID adds a human approval step.",
    label: "World ID required",
    detail: "0.042 ETH to studio.eth",
    icon: "fingerprint",
    partner: "world",
  },
  {
    title: "Confirm on your phone.",
    caption: "The phone signs after review. BeamPay routes the payment on an EVM testnet.",
    label: "Sample receipt",
    detail: "0.042 ETH · EVM testnet",
    icon: "circle-check",
    partner: null,
  },
];

export default function ProductPreview({ motion, Icon, Mark }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const button = useRef(null);
  const frame = frames[index];
  const last = index === frames.length - 1;

  useEffect(() => {
    if (!motion) setPlaying(false);
    if (!playing || !motion || last) return;
    const timeout = setTimeout(() => setIndex(index + 1), 3700);
    return () => clearTimeout(timeout);
  }, [playing, motion, index, last]);

  const play = () => {
    if (last) setIndex(0);
    setStarted(true);
    setPlaying(motion);
  };

  useEffect(() => {
    const start = () => {
      setIndex(0);
      setStarted(true);
      setPlaying(motion);
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener("beam-preview-start", start);
    return () => document.removeEventListener("beam-preview-start", start);
  }, [motion]);

  const go = (next) => {
    setStarted(true);
    setPlaying(false);
    setIndex(next);
  };

  return (
    <div className="preview-player" aria-label="Beam guided product preview">
      <SpotlightCard className="preview-stage" key={index} motion={motion}
        data-motion={motion && started ? "on" : "off"}>
        <div className="preview-copy">
          <div className="preview-brand"><Mark /> <span>Beam</span></div>
          <h2>{frame.title}</h2>
          <p>{frame.caption}</p>
        </div>
        <div className="preview-device" aria-hidden="true">
          <div className="preview-device-top"><span>9:41</span><i /><Icon name="battery-3" /></div>
          <div className="preview-device-body">
            {frame.partner ? <img src={`/assets/${frame.partner}.svg`} alt="" width="30" height="30" /> : <Icon name="circle-check" />}
            <b>{frame.label}</b>
            <span>{frame.detail}</span>
          </div>
          <div className="preview-device-button"><Icon name={frame.icon} /> <span>{index === 0 ? "Tap Beam" : "EVM testnet"}</span></div>
        </div>
      </SpotlightCard>
      {!started && (
        <div className="demo-launch-layer">
          <button className="button light demo-launch" onClick={() => {
            play();
            requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
          }}>
            <Icon name="player-play" /> Play guided demo <span className="demo-runtime">4 steps</span>
          </button>
        </div>
      )}
      <div className="preview-controls">
        <button ref={button} type="button" className="preview-control" onClick={playing && !last ? () => setPlaying(false) : play}
          disabled={!motion && started && !last}
          aria-label={playing && !last ? "Pause guided demo" : last ? "Replay guided demo" : "Play guided demo"}>
          <Icon name={playing && !last ? "player-pause" : last ? "refresh" : "player-play"} />
          <span className="preview-play-label">{playing && !last ? "Pause" : last ? "Replay" : "Play"}</span>
        </button>
        <div className="preview-progress" role="group" aria-label="Preview steps">
          {frames.map((item, i) => (
            <button key={item.label} aria-pressed={i === index} aria-label={`Step ${i + 1}: ${item.label}`} onClick={() => go(i)}>
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
        <span className="preview-count" role="status">{index + 1} / {frames.length}</span>
        <button type="button" className="preview-control" aria-label="Next preview step" onClick={() => go(index + 1)} disabled={last}>
          <Icon name="arrow-right" />
        </button>
      </div>
    </div>
  );
}
