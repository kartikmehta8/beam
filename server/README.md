# Beam server

Backend for the Beam Android app. It holds the LLM key, runs a Claude tool loop and returns **proposed**
payments (intents) in the network's native token: USDC on Arc testnet.
It also runs World ID approvals that end in an EIP-712 signature for the `BeamPay` contract, and mounts the
Beam handle (ENS) endpoints. It never holds user keys and never signs or sends a payment.

## Run

```bash
cp .env.example .env      # set AGENT_TOKEN, BEAMPAY_ADDRESS, ANTHROPIC_API_KEY
npm install
npm run dev               # tsx watch, http://localhost:8787
npm test                  # vitest, no network
npm run typecheck
npm run build && npm start
```

Node 20.12+. `.env` in the working directory is loaded on start; real environment variables win.

## Environment

| Env | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Without it every request uses the regex fallback parser. Required in production. |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | `claude-sonnet-5-5` if extraction quality is poor. |
| `AGENT_TOKEN` | (required) | Bearer token shared with the app. Production needs 32+ characters and not `change-me`. |
| `PORT` | `8787` | |
| `BEAM_NETWORK` | `arc` | `arc`. The app shows a banner if `/health` reports another chain. |
| `ARC_RPC_URL` | from `src/network.ts` | Read-only; reads retry 3 times with backoff. Overrides the default RPC. |
| `BEAMPAY_ADDRESS` | (required) | Deployed `BeamPay` on `BEAM_NETWORK`. |
| `ENS_CHAIN` | `mainnet` | `mainnet` or `sepolia`. |
| `ENS_RPC_URL` | PublicNode | `https://ethereum-rpc.publicnode.com` (mainnet) or `https://ethereum-sepolia-rpc.publicnode.com`: keyless and reliable for demos; use a keyed provider in production. |
| `WORLD_MODE` | `off` | `production` (World App), `staging` (World ID simulator, refused in production) or `off` (approvals return 503). |
| `WORLD_APP_ID`, `WORLD_RP_ID` | (none) | `app_...` and `rp_...` from the World developer portal. Required unless `off`. |
| `WORLD_RP_SIGNING_KEY` | (none) | The RP signing key (0x, 32 bytes). Secret: signs every proof request, never logged. Required unless `off`. |
| `APPROVER_PRIVATE_KEY` | (none) | Signs BeamPay approvals. Holds no funds. Required unless `WORLD_MODE=off`. |
| `HUMAN_HASH_SALT` | dev salt | 32-byte hex. Required in production. Changing it unlinks every human. |
| `WORLD_SESSIONS_PATH` | `data/world-sessions.json` | Linked wallets' World ID sessions. Back it up: BeamPay has no unlink, so losing it strands linked wallets. |
| `ENS_PARENT_NAME`, `ENS_REGISTRAR_PRIVATE_KEY`, `ENS_HANDLE_REGISTRY` | (none) | Beam handles (`src/handles/config.ts`). All three or none; none disables claims. |
| `MCP_WALLET_ADDRESS`, `MCP_DAILY_LIMIT` | (none), `100` | MCP server only. |

The server validates all of this with zod at startup. Errors name the variable, never its value.

### Tunnel to the phone

```bash
ngrok http --url=<your-domain>.ngrok-free.dev 8787
```

Set the app's `EXPO_PUBLIC_AGENT_URL` to that URL.

## API

All `/v1/*` routes need `Authorization: Bearer $AGENT_TOKEN` and have a 32 KB body limit. They share a 30
requests per minute limit, except polls of a known approval (`POST /v1/approvals/:id/complete`), which get
their own 2 per second window per approval id so polling never starves `/v1/agent`; polls of unknown ids count
against the shared limit. Errors are `{ error, message }`.

### `GET /health` (no auth)

```json
{ "ok": true, "network": "arc", "chainId": 5042002, "model": "claude-haiku-5-5",
  "beamPay": "0x...", "world": "staging", "handles": true, "ensChainId": 1 }
```

### `POST /v1/agent`

Request: `{ requestId, action?: "inspect" | "pay", messages (1 to 10, last from the user), context | null, wallet: { address, chainId }, limits: { dailyRemaining } }`.
`wallet.chainId` must equal the server's chain; `dailyRemaining` is a decimal string in the network's token.
`action` defaults to `"inspect"`. Clients must select `"pay"` through an explicit user payment action for the
current turn; prior messages and screen text cannot grant this permission. Inspection omits the payment tool
and rejects forced payment-tool calls. The phone also enforces local authorization independently of this field.

Response: `{ requestId, reply, intents, clarification, assessment, meta: { model, toolCalls, ms, fallback } }`. Each intent
carries `route` (`pay` or `payWithApproval`), `approvalReasons` (`OVER_CAP` from `BeamPay.capFor`, and
`EXTERNAL_AGENT` for MCP), `intentHash`, `to` (always an address) and `toName` when paid by ENS name.

Model failure, no API key, or the 25 s deadline fall back to the regex parser only for payment-authorized turns
(`meta.fallback: true`, still 200). Inspection returns no payment. A capture with detected injection indicators
returns fixed blocking copy and no intents before any model call; it cannot use payment fallback.

Agent tools: `get_wallet_balance` (balance and per-payment cap), `inspect_recipient` (address or ENS name),
`prepare_payment` (payment-authorized turns only; wraps the shared `prepareTransfer`), `get_tx_status`, `ask_user`,
`assess_screen` and the read-only `get_screen_context`. Captured content enters the model as a tool result,
not as part of a user message. See [prompt-injection protection](../docs/prompt-injection-protection.md) for
the complete boundary, phone authorization and detector limitations.

### World ID approvals (`/v1/approvals`)

| Route | Body | Response |
|---|---|---|
| `POST /v1/approvals` | `ApprovalRequest`: `{ kind: 'link' \| 'pay' \| 'cap' \| 'handle', wallet, pay?: { intentId, to, amountWei, intentHash, expiresAt? }, cap?: { capWei } }` | 201 `ApprovalStart`: `{ approvalId, connectUrl, expiresAt }` |
| `POST /v1/approvals/:id/complete` | none | 202 `{ status: 'pending' }`, then 200 `{ status: 'approved', kind, signature?, humanHash?, deadline?, alreadyLinked? }` once |

On start the server re-checks what it will sign: for `pay` it recomputes `intentHash` from the fields and
requires a checksummed non-zero recipient and a positive amount; `cap` must be at most `MAX_CAP` (1000);
`pay`, `cap` and `handle` need a wallet linked onchain and known to this server. It then signs an RP request,
opens an IDKit proof request bound to the approval and returns its `connectUrl` (`https://world.org/verify?...`,
or `https://staging.world.org/verify?...` in staging). The app opens it; World App returns to
`bubbleagent://approval` when done.

`complete` checks the request once (no long polling). While World App has not answered it returns 202. Any other
outcome consumes the approval. A proof is checked locally (environment, World ID 4.0, Proof of Human, action,
session and signal), verified with `POST https://developer.world.org/api/v4/verify/{rp_id}`, then the server
computes `humanHash = keccak256(abi.encodePacked(HUMAN_HASH_SALT, session_id))`, reads `BeamPay.humanOf` and
`nonces`, and:

- `link`: unlinked signs `HumanLink`; same human returns `alreadyLinked`; another human is `HUMAN_MISMATCH`.
- `pay` / `cap`: the linked human must match; signs `PayApproval` / `CapApproval` with
  `deadline = min(now + 5 min, intent expiry)` in unix seconds.
- `handle`: the linked human must match; the approval id can then be redeemed once by `POST /v1/handles`.

Approvals live 5 minutes and are single use.

| Status | Error |
|---|---|
| 400 | `BAD_REQUEST`, `APPROVAL_CANCELLED` (declined in World App) |
| 401 | `PROOF_INVALID` (World App error, wrong environment, signal, session or action, or rejected by World's verifier) |
| 403 | `HUMAN_MISMATCH`, `NOT_LINKED` |
| 404 | `APPROVAL_NOT_FOUND` |
| 409 | `APPROVAL_USED` (already approved, cancelled or failed) |
| 410 | `APPROVAL_EXPIRED` |
| 422 | `INTENT_INVALID` |
| 429 | `RATE_LIMITED` |
| 503 | `WORLD_NOT_CONFIGURED`, `WORLD_UNAVAILABLE` (bridge or verifier unreachable), `INTERNAL` (chain unreachable) |

A 503 from the bridge leaves the approval pending, so the next poll retries. A 503 from the verifier comes after
the approval was consumed: start again.

### World ID

Built on IDKit 4 (`@worldcoin/idkit-core`), entirely server-side: the RP signing key, the bridge key that decrypts
the proof, and the verification all stay on the server. The app only opens a URL and polls. Sources:
[IDKit integrate](https://docs.world.org/world-id/idkit/integrate),
[credentials](https://docs.world.org/world-id/idkit/credentials),
[session proofs](https://docs.world.org/world-id/idkit/session-proofs),
[4.0 migration](https://docs.world.org/world-id/4-0-migration),
[verify API](https://docs.world.org/api-reference/developer-portal/verify), and the package typings.

**What the user proves.** That they are a unique human verified at an Beam (the `proof_of_human` credential),
that they are the same human who linked this wallet, and that they approve this exact action. Nothing else is
disclosed: no name, document or attribute.

**Why Proof of Human.** It is the minimum that is sufficient. Beam pays because its agent reads untrusted text from
other apps; an approval must come from a real, unique person, not a bot, a script or a second account of the
same person (one link per human also keeps handles one per human). Selfie Check is medium assurance and does not
give that uniqueness; Passport and Identity Check prove document attributes Beam has no use for. The request uses
`CredentialRequest('proof_of_human')` with `allow_legacy_proofs: false` rather than the `proofOfHuman` preset,
because the preset adds a World ID 3.0 fallback whose nullifiers cannot carry a session.

**Why sessions, not a nullifier, identify the human.** In World ID 4.0 a uniqueness proof is one-time per action
for each user, and the docs say not to use its nullifier as a persistent identifier; `session_id` is the stable
link across requests. So:

- `link` is a uniqueness proof for the action `beam-approve` that also creates a session (`session_id: 'create'`).
  Its nullifier enforces one link per human (a second wallet gets `HUMAN_MISMATCH`); its `session_id` is saved
  for the wallet in `WORLD_SESSIONS_PATH` and becomes `humanHash = keccak256(abi.encodePacked(HUMAN_HASH_SALT,
  session_id))`, bound onchain by `BeamPay.linkHuman`. Linking again (for example after the transaction failed)
  proves the saved session instead.
- `pay`, `cap` and `handle` prove the saved session (`IDKit.proveSession`). The proof must carry exactly that
  `session_id`, so its `humanHash` must equal `BeamPay.humanOf(wallet)`. World App shows a one-line description
  of what is approved (for example "Pay 40 USDC to 0x12…cdef from Beam").

**How the signal binds an approval.** Every proof carries the signal
`beam:<approvalId>:<kind>:<wallet>:<intentHash | capWei | "">`. IDKit hashes it into the proof and World's
verifier checks the proof against that hash; the server also requires every response's `signal_hash` to equal
`hashSignal` of the approval's own signal. A proof therefore approves one approval, one wallet and one exact
payment or cap, and can never be replayed for another. Proofs are fetched by the server from the bridge with a
per-request key and never accepted from the client, and approvals are single use, so per-proof replay storage
(`session_nullifier`) is not needed.

**Checks before signing.** The result's `environment` must equal `WORLD_MODE` (checked before verifying, and the
verifier's answer must match too), `protocol_version` must be `4.0`, every response must be `proof_of_human`
with the approval's signal hash, an enrollment must be for `beam-approve` and a session proof for the saved
session. Then the verifier must answer `success: true`. Anything else is `PROOF_INVALID` and nothing is signed.

#### Testing with the simulator (staging)

The app `app_434e1889762005d1f29faa899ef8762a`, RP `rp_346985f8929bb5cf` and action `beam-approve` exist in
both the production and the staging environment.

1. `server/.env`: `WORLD_MODE=staging`, `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`,
   `APPROVER_PRIVATE_KEY` (and `HUMAN_HASH_SALT`, or accept the dev salt). Start the server and the tunnel;
   `GET /health` shows `"world": "staging"`.
2. In the app, **Profile → World ID → Link**. The connect URL opens `https://staging.world.org/verify`.
3. Open https://simulator.worldcoin.org (on a computer), create or pick an Beam-verified test identity, and paste
   the connect URL (or scan its QR code, if shown). Approve. The app's next poll returns the `HumanLink` signature.
4. Pay over the cap, raise the cap, or claim a handle: each opens a session proof that the same simulator
   identity approves. Decline in the simulator to see `APPROVAL_CANCELLED`; a different simulator identity
   linking another wallet is refused.

Staging proofs only verify as `staging`, and the server refuses `staging` when `NODE_ENV=production`.

#### Production (World App)

Set `WORLD_MODE=production` (and `NODE_ENV=production`, a real `HUMAN_HASH_SALT`). The connect URL opens World
App on the phone, the user approves with their Beam-verified World ID, and World App returns to
`bubbleagent://approval`. Staging links do not carry over: sessions and humans are per environment.

### Handles (`/v1/handles`)

Mounted from `src/handles/routes.ts` behind the same auth and rate limit. See `src/api.ts` for the shapes.

### Smoke test

```bash
curl -s $AGENT_URL/health | jq
curl -s $AGENT_URL/v1/agent -H "Authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' -d '{
  "requestId":"t1",
  "messages":[{"role":"user","text":"pay this"}],
  "context":{"source":"screen","appLabel":"WhatsApp","text":"dinner was $12, send to 0x<TEAMMATE_ADDRESS>","capturedAt":0},
  "wallet":{"address":"0x<YOUR_ADDRESS>","chainId":5042002},
  "limits":{"dailyRemaining":"100"}
}' | jq
curl -s $AGENT_URL/v1/approvals -H "Authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"link","wallet":"0x<YOUR_ADDRESS>"}' | jq
```

Expected: one intent with `route: "pay"` and `provenance.source: "screen"`; then a `connectUrl` (or 503
`WORLD_NOT_CONFIGURED` when `WORLD_MODE=off`).

## MCP (Claude Desktop)

`npm run build`, then add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "beam": { "command": "node", "args": ["/abs/path/server/dist/mcp.js"],
  "env": { "BEAM_NETWORK": "arc", "BEAMPAY_ADDRESS": "0x...", "MCP_WALLET_ADDRESS": "0x...",
           "MCP_DAILY_LIMIT": "100", "ENS_RPC_URL": "https://ethereum-rpc.publicnode.com" } } } }
```

Tools: `get_wallet_balance`, `inspect_recipient`, `get_tx_status`, and `prepare_payment` with an extra `context`
string (the text the payment is based on, at most 2000 characters, used for the provenance check). Every MCP
intent has `origin: "mcp"`, so `EXTERNAL_AGENT` always routes it through World ID approval. It returns the intent
JSON plus `reviewLink` (`bubbleagent://review?p=...`); the phone requires an explicit external review action and
re-validates it from scratch. Detected instruction-bearing context is rejected. It never signs or sends.

## Security and privacy

- Keys stay on the device. The server holds the approver key, which can only authorize BeamPay actions the wallet
  owner then submits; it cannot move funds. The per-payment cap is enforced onchain.
- Intents come only from `prepare_payment`, which checks recipient (address or ENS name), provenance (the
  recipient must appear on screen or in a user message, checked before any ENS lookup), amount, daily limit,
  gas and balance. Names resolve on the ENS chain; the address never comes from the model.
- World ID: the server never trusts the client about verification; it fetches the proof from the bridge itself,
  checks it is bound to the approval and verifies it with World. Onchain it stores only a salted hash of the
  app-scoped `session_id`; the session map file holds session ids and enrollment nullifiers, never logged.
- Screen text is confined to a read-only tool result and treated as untrusted. Current-turn capability gates
  payment preparation; a shared heuristic detector blocks known instruction patterns. Detection is incomplete,
  so the phone also requires an opaque local authorization and explicit review before execution.
- Logs are one JSON line per request: ids, latency, tool names, counts, routes, error codes, context length,
  approval kinds and outcomes, and addresses as first/last 4 characters only. No screen text, names, signals,
  session ids, nullifiers or keys.
- ENS lookups reveal which names were looked up to the ENS RPC provider.
- Demo-grade: the bearer token is bundled in the APK; rate limits and pending approvals are in process memory,
  and World ID sessions are a JSON file (single server process).
