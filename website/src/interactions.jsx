import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import TiltedCard from "./react-bits/TiltedCard.jsx";
import CountUp from "./react-bits/CountUp.jsx";
import SpotlightCard from "./react-bits/SpotlightCard.jsx";
import "./site.css";
import FeatureJourney from "./FeatureJourney.jsx";
import ProductPreview from "./ProductPreview.jsx";

const Icon = ({ name, ...props }) => (
  <svg className="icon" aria-hidden="true" {...props}>
    <use href={`/assets/icons.svg#${name}`} />
  </svg>
);
const Mark = () => (
  <span className="brand-mark" aria-hidden="true">
    <img src="/assets/beam-glyph.svg" alt="" />
  </span>
);
let inputMode = "pointer";
const media = window.matchMedia("(prefers-reduced-motion: reduce)");
function useMotion() {
  const [off, setOff] = useState(
    media.matches || document.documentElement.dataset.motion === "off",
  );
  useEffect(() => {
    const update = () =>
      setOff(
        media.matches || document.documentElement.dataset.motion === "off",
      );
    media.addEventListener("change", update);
    window.addEventListener("beam-motion", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("beam-motion", update);
    };
  }, []);
  return !off;
}
function useReveal(ref, key, motion) {
  useEffect(() => {
    if (!ref.current || !motion || inputMode === "keyboard") return;
    const animation = ref.current.animate(
      [
        { opacity: 0.6, transform: "translateY(5px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(.22,1,.36,1)" },
    );
    return () => animation.cancel();
  }, [key, motion]);
}
function PreviewExperience() {
  return <ProductPreview motion={useMotion()} Icon={Icon} Mark={Mark} />;
}
function FeatureExperience() {
  const motion = useMotion();
  return <FeatureJourney motion={motion} Icon={Icon} Mark={Mark} />;
}

const NETWORKS = [
  { name: "Ethereum Sepolia", chainId: 11155111 },
  { name: "Base Sepolia", chainId: 84532 },
];
const AMOUNTS = [
  { label: "0.0085", microEth: 8500 },
  { label: "0.012", microEth: 12000 },
  { label: "0.042", microEth: 42000 },
];
const SAMPLE_CAP_MICRO_ETH = 25000;
const SAMPLE_FIRST_PAYMENT_MICRO_ETH = 10000;
const APPS = [
  {
    name: "WhatsApp", icon: "brand-whatsapp", person: "Maya", initial: "M",
    context: "Coffee crew", recipient: "maya.eth", memo: "Coffee, covered.",
    request: "Coffee was a good call. Your half is",
    reply: "On it. Let me ask Beam.", initialAmount: 0,
  },
  {
    name: "Email", icon: "mail", person: "Arjun", initial: "A",
    context: "Design review", recipient: "studio.eth", memo: "Design review",
    request: "Thanks for the review! The session was",
    reply: "I’ll check it in Beam.", initialAmount: 2,
  },
  {
    name: "Telegram", icon: "brand-telegram", person: "Anika", initial: "A",
    context: "Weekend plans", recipient: "anika.eth", memo: "Dinner split",
    request: "Your share for dinner is",
    reply: "Let me check the request.", initialAmount: 1, firstPayment: true,
  },
];

function approvalReason(amount, firstPayment) {
  if (amount.microEth > SAMPLE_CAP_MICRO_ETH) return "Above the sample 0.025 ETH per-payment cap.";
  if (firstPayment && amount.microEth >= SAMPLE_FIRST_PAYMENT_MICRO_ETH) {
    return "First payment of 0.01 ETH or more to this sample recipient.";
  }
  return "";
}

function Playground() {
  const [app, setApp] = useState(0),
    [networkIndex, setNetworkIndex] = useState(0),
    [amountIndex, setAmountIndex] = useState(APPS[0].initialAmount),
    [phase, setPhase] = useState("screen"),
    [step, setStep] = useState(0),
    [keyboard, setKeyboard] = useState(false),
    [spin, setSpin] = useState(false),
    [tour, setTour] = useState(false);
  const motion = useMotion(),
    phone = useRef(null),
    timer = useRef(null),
    sheet = useRef(null),
    a = APPS[app],
    network = NETWORKS[networkIndex],
    amount = AMOUNTS[amountIndex],
    approval = approvalReason(amount, a.firstPayment),
    message = `${a.request} ${amount.label} ETH. Send it to ${a.recipient}?`;
  const previousPhase = useRef(phase);
  useReveal(sheet, phase, motion);
  useEffect(() => {
    if (previousPhase.current !== phase && keyboard) sheet.current?.focus({ preventScroll: true });
    previousPhase.current = phase;
  }, [phase, keyboard]);
  const clear = () => {
    clearTimeout(timer.current);
    timer.current = null;
  };
  const reset = () => {
    clear();
    setPhase("screen");
    setStep(0);
    setSpin(false);
    setTour(false);
  };
  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (!motion || keyboard) setSpin(false);
  }, [motion, keyboard]);
  useEffect(() => {
    const key = (e) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
        setKeyboard(true);
        setSpin(false);
      }
      if (e.key === "Escape") reset();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [app]);
  useEffect(() => {
    const el = phone.current;
    if (!spin || !el) return;
    const anim = el.animate(
      [{ transform: "rotateY(0deg)" }, { transform: "rotateY(360deg)" }],
      { duration: 900, easing: "cubic-bezier(.22,1,.36,1)" },
    );
    anim.onfinish = () => setSpin(false);
    return () => anim.cancel();
  }, [spin]);
  const scan = (guided = false) => {
    clear();
    setPhase("scanning");
    setStep(1);
    setTour(guided);
    timer.current = setTimeout(() => {
      setPhase("review");
      setStep(2);
      if (guided && !approval) timer.current = setTimeout(pay, 1800);
      else setTour(false);
    }, 650);
  };
  const pay = () => {
    clear();
    setTour(false);
    setPhase("processing");
    timer.current = setTimeout(() => {
      setPhase("success");
      if (
        motion &&
        !keyboard &&
        window.matchMedia("(max-width:767px)").matches &&
        !document.hidden
      )
        setSpin(true);
    }, 700);
  };
  const tryStep = (index) => {
    setStep(index);
    if (index === 0) reset();
    if (index === 1) scan();
    if (index === 2) {
      clear();
      setPhase("review");
    }
  };
  return (
    <div className="playground" onPointerDown={() => setKeyboard(false)}>
      <div className="playground-top">
        <span>
          <span className="status-dot" /> Your apps. One Beam.
        </span>
        <span className="demo-label">Interactive demo · no funds sent</span>
      </div>
      <div className="playground-config">
        <fieldset>
          <legend>Sample network</legend>
          <div className="demo-choices">
            {NETWORKS.map((item, i) => (
              <button key={item.chainId} type="button" aria-pressed={networkIndex === i}
                onClick={() => {
                  if (networkIndex === i) return;
                  reset();
                  setNetworkIndex(i);
                }}>
                {item.name}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Sample amount</legend>
          <div className="demo-choices">
            {AMOUNTS.map((item, i) => (
              <button key={item.label} type="button" aria-pressed={amountIndex === i}
                onClick={() => {
                  if (amountIndex === i) return;
                  reset();
                  setAmountIndex(i);
                }}>
                {item.label} ETH
              </button>
            ))}
          </div>
        </fieldset>
        <div className="demo-choice-summary">
          <div className="demo-draft-amount" aria-hidden="true">
            <span>Draft amount</span>
            <b><CountUp to={amount.microEth / 1e6} motion={motion && !keyboard} /> ETH</b>
          </div>
          <p className="demo-choice-status" role="status">
            <span>
              <span className="demo-sr-only">{amount.label} ETH. </span>
              Chain ID {network.chainId} · browser simulation
            </span>
            <strong>
              <Icon name={approval ? "shield-check" : "fingerprint"} />
              {approval ? "World ID + phone confirmation" : "Phone confirmation"}
            </strong>
          </p>
        </div>
      </div>
      <div className="playground-grid">
        <div className="screen-context">
          <div className="app-picker" role="group" aria-label="Sample app">
            {APPS.map((item, i) => (
              <button
                key={item.name}
                aria-label={item.name}
                aria-pressed={app === i}
                onClick={() => {
                  reset();
                  setApp(i);
                  setAmountIndex(item.initialAmount);
                }}
              >
                <Icon name={item.icon} />
                <span>{item.name}</span>
              </button>
            ))}
          </div>
          <div className="chat-desktop" aria-hidden="true">
            <div className="chat-title">
              <span className="avatar">{a.initial}</span>
              <div>
                <b>{a.person}</b>
                <small>{a.context}</small>
              </div>
              <Icon name={a.icon} />
            </div>
            <div className="chat-message">
              {message}
              <small>9:40</small>
            </div>
            <div className="chat-reply">
              {a.reply}
              <Icon name="checks" />
            </div>
            <p>Payment details are already here.</p>
            <span className="screen-doodle">
              <Icon name="corner-right-down" /> So is your wallet.
            </span>
          </div>
          <div className="screen-note">
            <Icon name="info-circle" />
            <p>
              Beam reads accessible text from the screen when you tap, or uses copied text.
              These examples illustrate the overlay.
            </p>
          </div>
        </div>
        <div className="phone-stage">
          <TiltedCard
            containerHeight="640px"
            containerWidth="310px"
            imageHeight="640px"
            imageWidth="310px"
            radius={38}
            rotateAmplitude={motion && !keyboard && !spin ? 5 : 0}
            scaleOnHover={motion && !keyboard && !spin ? 1.008 : 1}
            glare={0}
            shadow={0}
            gyroscope={false}
            floating={motion && !keyboard && !spin}
            intro={false}
            flipOnClick={false}
            className="demo-depth"
          >
            <div className="phone-rotation" ref={phone} data-celebrating={spin}>
              <div className="phone-back" aria-hidden="true">
                <Mark />
                <span>Back to what matters.</span>
              </div>
              <div className="phone">
                <div className="phone-status">
                  <b>9:41</b>
                  <span className="camera" />
                  <span>
                    <Icon name="antenna-bars-5" />
                    <Icon name="wifi" />
                    <Icon name="battery-3" />
                  </span>
                </div>
                <div className="phone-app">
                  <div className="phone-app-header">
                    <Icon name="chevron-left" />
                    <span className="avatar">{a.initial}</span>
                    <div>
                      <b>{a.person}</b>
                      <small>
                        {a.name === "Email" ? "arjun@example.test" : "online"}
                      </small>
                    </div>
                    <Icon name={a.icon} />
                  </div>
                  <div className="phone-chat">
                    <small>Today</small>
                    <div className="chat-message">
                      {message}
                      <small>9:40</small>
                    </div>
                    <div className="chat-reply">{a.reply}</div>
                    <div className="composer">
                      <span>
                        {a.name === "Email" ? "Write a reply…" : "Message…"}
                      </span>
                      <Icon name="microphone" />
                    </div>
                  </div>
                </div>
                {phase === "screen" ? (
                  <button
                    className="floating-beam"
                    onClick={() => scan()}
                    aria-label="Tap Beam to scan sample screen"
                  >
                    <Mark />
                  </button>
                ) : (
                  <div className="payment-sheet" ref={sheet} key={phase} tabIndex={-1} aria-label="Sample payment sheet">
                    <div className="sheet-handle" />
                    <div className="sheet-header">
                      <span>
                        <Mark />
                        <b>Beam</b>
                        <span className="testnet">{network.name}</span>
                      </span>
                      <button
                        className="icon-button"
                        aria-label="Close sample payment"
                        onClick={() => reset()}
                      >
                        <Icon name="x" />
                      </button>
                    </div>
                    {phase === "scanning" || phase === "processing" ? (
                      <div className="phone-loading" role="status">
                        <Icon
                          name={phase === "scanning" ? "scan" : "loader-2"}
                        />
                        <h3>
                          {phase === "scanning"
                            ? "Reading the sample…"
                            : "Simulating confirmation…"}
                        </h3>
                        <p>
                          {phase === "scanning"
                            ? "Finding the amount, recipient and network."
                            : "This demo never sends a transaction."}
                        </p>
                      </div>
                    ) : phase === "success" ? (
                      <div className="phone-success" role="status">
                        <span className="success-check">
                          <Icon name="check" />
                        </span>
                        <h3>All set.</h3>
                        <p>{amount.label} ETH to {a.recipient}</p>
                        <div className="receipt">
                          <b>{a.memo}</b>
                          <small>Payment simulated · {network.name}</small>
                        </div>
                        <button
                          className="button"
                          onClick={async (e) => {
                            const btn = e.currentTarget;
                            try {
                              await navigator.clipboard.writeText(
                                `Beam demo receipt — ${amount.label} ETH to {a.recipient} on ${network.name} (chain ${network.chainId}). SIMULATED. No funds sent.`,
                              );
                              btn.textContent = "Sample receipt copied";
                            } catch {
                              btn.textContent = "Clipboard unavailable";
                            }
                          }}
                        >
                          Copy sample receipt <Icon name="copy" />
                        </button>
                        <button className="text-button" onClick={() => reset()}>
                          Try it again <Icon name="refresh" />
                        </button>
                        <small>Demo receipt only. Nothing was sent.</small>
                      </div>
                    ) : phase === "declined" ? (
                      <div className="phone-loading" role="status">
                        <Icon name="shield-x" />
                        <h3>Request declined.</h3>
                        <p>The payment stopped before device confirmation.</p>
                        <button className="text-button" onClick={() => reset()}>Try it again</button>
                      </div>
                    ) : (
                      <div className="phone-review">
                        <p className="review-caption">{phase === "world" ? "World ID approval" : "Review payment"}</p>
                        <h3>
                          {amount.label} <span>ETH</span>
                        </h3>
                        <p>
                          to <strong>{a.recipient}</strong>
                        </p>
                        <span className="mono">0x7a…9B2e · sample address</span>
                        {approval && (
                          <div className={`risk-label ${phase === "ready" ? "safe" : "warning"}`}>
                            <img src="/assets/world.svg" alt="" width="16" height="16" />
                            <b>{phase === "ready" ? "Sample World ID approved" : "World ID required"}</b>
                          </div>
                        )}
                        {approval && phase !== "ready" && <p className="fine approval-reason">{approval}</p>}
                        <dl>
                          <div>
                            <dt>Network</dt>
                            <dd>{network.name}</dd>
                          </div>
                          <div>
                            <dt>For</dt>
                            <dd>{a.memo}</dd>
                          </div>
                        </dl>
                        <button className="button" onClick={() => {
                          if (phase === "world") setPhase("ready");
                          else if (approval && phase !== "ready") setPhase("world");
                          else pay();
                        }}>
                          <Icon name={phase === "world" ? "check" : "fingerprint"} />
                          {phase === "world" ? "Simulate World ID approval" :
                            approval && phase !== "ready" ? "Review World ID step" : "Simulate payment"}
                        </button>
                        <button className="text-button" onClick={() => phase === "world" ? setPhase("declined") : reset()}>
                          {phase === "world" ? "Decline" : "Cancel"}
                        </button>
                        <small>Illustrative review. No wallet connected.</small>
                      </div>
                    )}
                  </div>
                )}
                <div className="home-indicator" />
              </div>
            </div>
          </TiltedCard>
          <div className="phone-caption">
            <span className="status-dot" />
            {phase === "screen"
              ? "Tap the floating Beam to try it."
              : phase === "success"
                ? "That’s the flow. You stay in control."
                : "A sample payment. Your next move."}
          </div>
        </div>
        <aside className="playground-rail">
          <div>
            <Icon name="scan" />
            <h3>
              See it.
              <br />
              Pay it.
            </h3>
            <p>From a message to a review, without the app shuffle.</p>
          </div>
          <div className="rail-safety">
            <span className="risk-label safe">
              <Icon name="shield-check" /> Looks safe
            </span>
            <p>Risk signals travel with the payment.</p>
            <a href="#scam-shield" className="text-link">
              Meet Scam Shield <Icon name="arrow-up-right" />
            </a>
          </div>
          <div className="rail-agent">
            <span className="agent-mini">
              <Icon name="terminal-2" /> Agent request
            </span>
            <p>“Pay 0.006 ETH for API credits.”</p>
            <span>Waiting for your approval</span>
          </div>
        </aside>
      </div>
      <div className="demo-bottom">
        <div className="demo-steps" aria-label="Demo stages">
          {["Screen", "Read", "Review"].map((label, i) => (
            <button
              key={label}
              aria-pressed={step === i}
              onClick={() => tryStep(i)}
            >
              <span>{i + 1}</span>
              {label}
            </button>
          ))}
        </div>
        <button
          className="text-button"
          onClick={() => (tour ? reset() : scan(true))}
        >
          <Icon name={tour ? "player-stop" : "player-play"} />
          {tour ? "Stop walkthrough" : "Play walkthrough"}
        </button>
      </div>
    </div>
  );
}
const SAFETY = [
  {
    label: "Coffee split",
    status: "Looks safe",
    kind: "safe",
    icon: "shield-check",
    message:
      "Your half is 0.0085 ETH. Send it to maya.eth for coffee?",
    signals: [
      "No common warning signs in this sample.",
      "Still check the recipient, amount and network.",
    ],
  },
  {
    label: "Urgent message",
    status: "Be careful",
    kind: "warning",
    icon: "alert-triangle",
    message:
      "Support here. Act now or your wallet will be blocked. Open this short link immediately.",
    signals: [
      "Urgency pressures you to act quickly.",
      "The sender claims to be support.",
      "A shortened link hides the destination.",
    ],
  },
  {
    label: "Refund trap",
    status: "Likely scam",
    kind: "danger",
    icon: "shield-x",
    message:
      "To receive your refund, install AnyDesk and pay a 0.01 ETH processing fee. Share your recovery phrase to verify.",
    signals: [
      "Asks for a secret recovery phrase.",
      "Requests remote-access software.",
      "Asks you to pay to receive money.",
    ],
  },
];
function Shield() {
  const [active, setActive] = useState(1),
    s = SAFETY[active],
    ref = useRef(null),
    motion = useMotion();
  useReveal(ref, active, motion);
  return (
    <div className="shield-lab">
      <div className="shield-message">
        <div className="chips" role="group" aria-label="Safety examples">
          {SAFETY.map((x, i) => (
            <button
              key={x.label}
              aria-pressed={i === active}
              onClick={() => setActive(i)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <Icon name="message-circle" />
        <blockquote>“{s.message}”</blockquote>
        <p className="fine">Sample message · not a live scan</p>
      </div>
      <div
        className={`shield-verdict ${s.kind}`}
        key={s.kind}
        ref={ref}
        aria-live="polite"
      >
        <span className="verdict-symbol">
          <Icon name={s.icon} />
        </span>
        <h3>{s.status}</h3>
        <ul>
          {s.signals.map((x) => (
            <li key={x}>
              <Icon name="arrow-up-right" />
              {x}
            </li>
          ))}
        </ul>
        <p>
          {s.kind === "danger"
            ? "Beam surfaces these warning signs in the review. You can cancel the request."
            : "Beam explains the signals. The decision stays yours."}
        </p>
      </div>
    </div>
  );
}
const CLIENTS = ["Claude Desktop", "Codex", "Other MCP"];
function Agents() {
  const motion = useMotion();
  const [client, setClient] = useState(0),
    [state, setState] = useState("idle"),
    [copy, setCopy] = useState(false);
  const env = {
    BEAMPAY_ADDRESS: "<configured-contract>",
    MCP_WALLET_ADDRESS: "<wallet-address>",
  };
  const server = { command: "node", args: ["/path/to/beam/server/dist/mcp.js"], env };
  const continuation = " " + String.fromCharCode(92) + "\n  ";
  const snippet = client === 0 ? JSON.stringify({ mcpServers: { beam: server } }, null, 2)
    : client === 1 ? [
        "codex mcp add beam",
        "--env BEAMPAY_ADDRESS='<configured-contract>'",
        "--env MCP_WALLET_ADDRESS='<wallet-address>'",
        "-- node /path/to/beam/server/dist/mcp.js",
      ].join(continuation)
    : JSON.stringify(server, null, 2);
  return (
    <div className="agent-workspace">
      <div className="agent-terminal">
        <div className="terminal-top">
          <span>
            <i />
            <i />
            <i />
          </span>
          <span>Connect your client</span>
        </div>
        <div className="agent-picker" role="group" aria-label="MCP client">
          {CLIENTS.map((x, i) => (
            <button
              key={x}
              aria-pressed={client === i}
              onClick={() => {
                setClient(i);
                setCopy(false);
              }}
            >
              {x}
            </button>
          ))}
        </div>
        <pre>
          <code>{snippet}</code>
        </pre>
        <button
          className="terminal-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(snippet);
              setCopy(true);
            } catch {
              setCopy(false);
            }
          }}
        >
          <Icon name={copy ? "check" : "copy"} />
          {copy ? "Copied" : "Copy template"}
        </button>
        <p>
          Build the server first, then configure your client to launch it over
          stdio. Use the contract address for your configured network.
        </p>
        <div className="agent-limit">
          <span>Per-payment limit</span>
          <b>0.025 ETH</b>
          <span>MCP daily limit</span>
          <b>0.10 ETH</b>
        </div>
        <small>Sample configuration · external requests require World ID</small>
      </div>
      <SpotlightCard className="agent-approval" motion={motion}>
        <div className="agent-path">
          <Icon name="terminal-2" />
          <span />
          <Mark />
          <span />
          <Icon name="device-mobile" />
        </div>
        <span className="agent-mini" role="status">
          {state === "idle"
            ? "Ready to ask"
            : state === "pending"
              ? "Request on your phone"
              : state === "declined"
                ? "Request declined"
                : state === "ready" ? "World ID approved" : "Payment simulated"}
        </span>
        <h3>
          {state === "idle"
            ? "Your agent asks. You decide."
            : state === "pending"
              ? "API credits. 0.006 ETH."
              : "Your decision makes the difference."}
        </h3>
        <p>
          {state === "idle"
            ? "Try a local example of an agent requesting payment. No key or wallet required."
            : state === "pending"
              ? "The agent proposes 0.006 ETH to studio.eth on the sample EVM testnet. Open the review link and approve with your linked World ID."
              : state === "declined"
                ? "The phone stopped the request before confirmation."
                : state === "ready"
                  ? "The sample World ID check passed. The phone still asks you to confirm the send."
                  : "The browser simulated a receipt. No funds moved."}
        </p>
        {state === "pending" ? (
          <div className="actions">
            <button className="button" onClick={() => setState("ready")}>
              Simulate World ID approval <Icon name="check" />
            </button>
            <button
              className="text-button"
              onClick={() => setState("declined")}
            >
              Decline
            </button>
          </div>
        ) : state === "ready" ? (
          <div className="actions">
            <button className="button" onClick={() => setState("approved")}>
              Simulate device confirmation <Icon name="fingerprint" />
            </button>
            <button className="text-button" onClick={() => setState("declined")}>Cancel</button>
          </div>
        ) : (
          <button
            className="button secondary"
            onClick={() => setState(state === "idle" ? "pending" : "idle")}
          >
            {state === "idle" ? "Try an agent request" : "Reset example"}
            <Icon name="arrow-up-right" />
          </button>
        )}
        <small>Illustrative MCP flow. No live agent connected.</small>
      </SpotlightCard>
    </div>
  );
}
const STEPS = [
  {
    title: "Bring the details into view.",
    body: "Open a message, email or another screen with an amount and recipient. If an app hides its text from accessibility, copy the details instead.",
    icon: "message-circle",
    preview: "“Send 0.0085 ETH to maya.eth on testnet.”",
  },
  {
    title: "Tap the floating Beam.",
    body: "Beam reads accessible visible text on demand. Ask “pay this” or “is this safe?” You can inspect and exclude the captured text.",
    icon: "scan",
    preview: "Amount  0.0085 ETH\nRecipient  maya.eth\nNetwork  EVM testnet",
  },
  {
    title: "Review before you approve.",
    body: "Check the recipient, amount and risk signals. Over-cap, first-time and external-agent requests can ask for World ID before device confirmation.",
    icon: "fingerprint",
    preview:
      "Review payment\n0.0085 ETH → maya.eth\nLooks safe · Check every detail",
  },
  {
    title: "Get back to the conversation.",
    body: "Beam signs on your device and shows the transaction status. Confirmation time depends on the network; this website only simulates it.",
    icon: "check",
    preview: "All set.\nPayment simulated\nNo funds sent.",
  },
];
function How() {
  const [index, setIndex] = useState(0),
    s = STEPS[index];
  const start = useRef(null);
  return (
    <div
      className="how-demo"
      onTouchStart={(e) => {
        start.current =
          e.touches.length === 1
            ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
            : null;
      }}
      onTouchEnd={(e) => {
        if (!start.current || e.changedTouches.length !== 1) return;
        const dx = e.changedTouches[0].clientX - start.current.x,
          dy = e.changedTouches[0].clientY - start.current.y;
        start.current = null;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
          setIndex((n) => Math.max(0, Math.min(3, n + (dx < 0 ? 1 : -1))));
      }}
    >
      <div className="how-tabs" role="tablist" aria-label="How Beam works">
        {STEPS.map((x, i) => (
          <button
            key={x.title}
            role="tab"
            id={`step-${i}`}
            aria-controls="how-panel"
            aria-selected={index === i}
            tabIndex={index === i ? 0 : -1}
            onClick={() => setIndex(i)}
            onKeyDown={(e) => {
              let n;
              if (e.key === "ArrowRight") n = (i + 1) % 4;
              if (e.key === "ArrowLeft") n = (i + 3) % 4;
              if (e.key === "Home") n = 0;
              if (e.key === "End") n = 3;
              if (n !== undefined) {
                e.preventDefault();
                setIndex(n);
                document.getElementById(`step-${n}`).focus();
              }
            }}
          >
            <span>{i + 1}</span>
            {["Open", "Tap", "Review", "Return"][i]}
          </button>
        ))}
      </div>
      <div
        className="how-panel"
        id="how-panel"
        role="tabpanel"
        aria-labelledby={`step-${index}`}
      >
        <div className="how-preview" key={index}>
          <Icon name={s.icon} />
          <pre>{s.preview}</pre>
          <span>Illustrative flow</span>
        </div>
        <div className="how-copy">
          <h3>{s.title}</h3>
          <p>{s.body}</p>
          <div className="how-controls">
            <button
              className="icon-button"
              aria-label="Previous step"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <Icon name="arrow-left" />
            </button>
            <span>{index + 1} / 4</span>
            <button
              className="icon-button"
              aria-label="Next step"
              disabled={index === 3}
              onClick={() => setIndex(index + 1)}
            >
              <Icon name="arrow-right" />
            </button>
            <a href="#playground" className="text-link">
              Try it above <Icon name="arrow-up-right" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

[
  ["preview-mount", PreviewExperience],
  ["playground-mount", Playground],
  ["journey-mount", FeatureExperience],
  ["shield-mount", Shield],
  ["agents-mount", Agents],
  ["how-mount", How],
].forEach(([id, Component]) => {
  const el = document.getElementById(id);
  if (el) createRoot(el).render(<Component />);
});
const motionButton = document.getElementById("motion-toggle");
let manuallyPaused = false;
const updateMotion = () => {
  const off = manuallyPaused || media.matches;
  document.documentElement.dataset.motion = off ? "off" : "on";
  motionButton.setAttribute("aria-pressed", String(off));
  motionButton.setAttribute(
    "aria-label",
    off ? "Resume motion" : "Pause motion",
  );
  motionButton.querySelector("span").textContent = off
    ? "Resume motion"
    : "Pause motion";
  motionButton
    .querySelector("use")
    .setAttribute("href", `/assets/icons.svg#player-${off ? "play" : "pause"}`);
  window.dispatchEvent(new Event("beam-motion"));
};
motionButton.addEventListener("click", () => {
  manuallyPaused = !manuallyPaused;
  updateMotion();
});
media.addEventListener("change", updateMotion);
updateMotion();
window.addEventListener("keydown", (e) => {
  if (!["Shift", "Control", "Alt", "Meta"].includes(e.key))
    inputMode = "keyboard";
});
window.addEventListener("pointerdown", () => (inputMode = "pointer"));
document.querySelectorAll("[data-play-demo]").forEach((link) => {
  link.addEventListener("click", () => document.dispatchEvent(new Event("beam-preview-start")));
});
const search = document.getElementById("faq-search");
if (search) {
  let topic = "All";
  const rows = [...document.querySelectorAll(".faq-list details")],
    expand = document.getElementById("faq-expand");
  const visible = () => rows.filter((x) => !x.hidden);
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    for (const row of rows)
      row.hidden = !(
        (topic === "All" || row.dataset.topic === topic) &&
        row.textContent.toLowerCase().includes(q)
      );
    const count = visible().length;
    document.getElementById("faq-count").textContent =
      `${count} ${count === 1 ? "answer" : "answers"}`;
    document.getElementById("faq-empty").hidden = count > 0;
    expand.hidden = count === 0;
    expand.textContent = visible().every((x) => x.open)
      ? "Collapse all"
      : "Expand all";
  };
  search.addEventListener("input", filter);
  document.querySelectorAll("#faq-topics button").forEach((btn) =>
    btn.addEventListener("click", () => {
      topic = btn.dataset.topic;
      document
        .querySelectorAll("#faq-topics button")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
      filter();
    }),
  );
  expand.addEventListener("click", () => {
    const open = !visible().every((x) => x.open);
    visible().forEach((x) => (x.open = open));
    expand.textContent = open ? "Collapse all" : "Expand all";
  });
  document.getElementById("faq-reset").addEventListener("click", () => {
    search.value = "";
    topic = "All";
    document
      .querySelectorAll("#faq-topics button")
      .forEach((x) =>
        x.setAttribute("aria-pressed", String(x.dataset.topic === "All")),
      );
    filter();
    search.focus();
  });
  rows.forEach((row) => {
    row.addEventListener("toggle", () => {
      expand.textContent = visible().every((x) => x.open)
        ? "Collapse all"
        : "Expand all";
      if (
        row.open &&
        inputMode !== "keyboard" &&
        !media.matches &&
        document.documentElement.dataset.motion !== "off"
      )
        row.querySelector(".faq-answer").animate(
          [
            { opacity: 0.4, transform: "translateY(-4px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 180, easing: "cubic-bezier(.22,1,.36,1)" },
        );
    });
  });
}
const checklist = [...document.querySelectorAll("[data-step]")];
if (checklist.length) {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem("beam-setup-steps-v1") || "[]");
    if (!Array.isArray(saved)) saved = [];
  } catch {}
  const update = () => {
    document.getElementById("setup-progress").textContent =
      `${checklist.filter((x) => x.checked).length} of ${checklist.length} steps checked`;
    try {
      localStorage.setItem(
        "beam-setup-steps-v1",
        JSON.stringify(checklist.map((x) => x.checked)),
      );
    } catch {}
  };
  checklist.forEach((el, i) => {
    el.checked = saved[i] === true;
    el.addEventListener("change", update);
  });
  update();
}
