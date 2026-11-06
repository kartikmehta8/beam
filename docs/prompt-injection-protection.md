# Prompt-injection protection

Beam treats screen text, clipboard text and MCP review context as untrusted
external content. Finding a recipient in that content establishes provenance;
it does not establish that the user authorized a payment. The protections below
separate those two decisions without changing the BeamPay contracts.

## Current-turn permission

Ordinary chat, voice input and inspection actions do not authorize payment
preparation. The phone user must choose **Pay this**, **Prepare payment** or an
explicit external-payment review action. Permission is scoped to that action;
earlier payment requests and model replies cannot grant it to a later turn.

`POST /v1/agent` accepts `action: "inspect" | "pay"`, defaulting to `"inspect"`
when omitted. In inspection mode the server omits `prepare_payment` from the
model's tools and independently rejects attempted calls with
`PAYMENT_NOT_AUTHORIZED`. The direct preparation tool and offline fallback also
enforce the gate. The phone discards server-proposed payments on inspection
turns, including responses from older or compromised servers.

The API field is not authentication or proof that somebody tapped a button.
The existing bearer token remains demo-grade. The final phone execution gate is
local and cannot be supplied by a serialized server response.

## Captured content and detection

The model receives submitted captures through the registered read-only
`get_screen_context` tool. The initial capture uses a matching `tool_use` and
`tool_result` exchange; raw capture text is not concatenated into the user's
message. Tool results identify the whole capture, including its app label, as
untrusted external data. The system prompt describes that boundary and the
current turn's capability.

The shared `app/src/injection.ts` and `server/src/injection.ts` detector scans
external context for four categories: instruction overrides, role spoofing,
concealment and recipient redirection. It normalizes simple Unicode/invisible
character obfuscation and bounds input size. Suspected captures are blocked
before the model is called, in server/MCP payment preparation, and again during
local phone preparation. The phone displays fixed explanatory copy rather than
an attacker-written explanation.

Detection is heuristic. A match can be a false positive; no match does not mean
the content is safe. Paraphrases, other languages, homoglyphs and unknown attack
patterns can evade the detector. Role separation and the detector supplement
the deterministic permission gates; neither is a security proof. Scam Shield's
separate risk assessment remains advisory. A blocked injection response omits
that assessment so it cannot simultaneously display or read aloud "Looks safe."

## Local execution authorization

`app/src/paymentAuthorization.ts` holds opaque authorization objects in local
WeakMaps. An authorization binds the signed-in wallet and the exact intent ID,
recipient, amount, chain, network, intent hash and execution route. It expires
at the earlier of five minutes or the intent expiry. Copying, serializing or
inventing an authorization object does not create a valid entry.

The review UI revokes the scope when the action, capture, context selection,
wallet or relevant input changes, or the sheet loses focus/closes. Old payment
cards are cleared. Execution checks the current scope before and after async
validation and again before sending, so a stale biometric/review callback
cannot authorize a different or revoked payment.

Authorization opens a review path; it does not send funds. Existing biometric
or device-PIN confirmation (or hold-to-confirm), World ID where required,
balance/limit/name/replay checks, and transaction simulation still apply. This
protects the trusted application flow, not a compromised phone runtime or
someone bypassing the app and using their wallet directly.

## Manual and external payments

**Enter payment manually** starts with blank recipient and amount fields.
Neither field is prefilled from the capture or model. This path prepares locally
with `context: null`, using only the entered values as provenance and marking
the result `parsedBy: "manual"`. It avoids sending the flagged capture to the
model and retains normal payment validation and confirmation. It does not
guarantee that an address the user types is trustworthy.

MCP remains proposal-only. Suspected external context is rejected, and opening a
review link does not automatically prepare or send a payment. The phone user
must choose **Review external payment**, after which the proposal is rebuilt
locally and receives a fresh local scope. MCP-origin payments retain
`EXTERNAL_AGENT` and always require World ID before the normal device
confirmation. Manual entry is a separate user-authored payment, not approval of
the external proposal.

## Verification and relevant files

Server regressions use scripted model outputs, including an in-limit $5 payment
tool call during inspection, prior-history permission attempts, suspected
captures, offline fallback, missing API action and MCP input. App tests cover
inspection responses, local fallback and opaque authorization binding,
expiry/revocation and forged/copy/serialized tokens. Detector tests cover
representative hostile and benign strings; shared-file tests prevent drift.
These checks do not demonstrate a successful live-model exploit or complete
resistance to prompt injection. Device/emulator review remains necessary for
the native confirmation and lifecycle behavior.

Verified on 6 November 2026 against upstream commit `024a56b`:

- App: 41 tests passed; lint and TypeScript checks passed.
- Server: 308 tests passed; lint, TypeScript checks and build passed.
- Android JavaScript/Hermes export completed successfully. This is a bundle
  check, not an APK build or physical-device test.
- Frozen-lockfile installation passed after synchronizing the app lockfile
  with the existing `ws` override. Two existing app lint issues were also fixed.
- 21 server ABI tests were skipped because the compiled contract artifact was
  unavailable. No live-model attack or live payment was exercised.

Before merging, smoke-test the inspection/payment buttons, suspicious-context
warning and blank manual form, external review followed by World ID, and
context/input changes while confirmation is pending on an Android device.

Run the normal checks:

```sh
cd server
npm test
npm run lint
npm run typecheck
npm run build

cd ../app
pnpm test
pnpm lint
pnpm typecheck
```

Server ABI comparison tests skip when `contracts/out/BeamPay.sol/BeamPay.json`
is absent; build contracts with Foundry to enable them. This change does not
modify Solidity, contract ABIs, onchain cap rules or World ID proof verification.

Main implementation points: `server/src/{schemas,agent,prompt}.ts`,
`server/src/tools/{index,tool,preparePayment,getScreenContext}.ts`,
`app/src/{agentApi,prepare,paymentAuthorization,execute}.ts`, and
`app/app/ask.tsx`.
