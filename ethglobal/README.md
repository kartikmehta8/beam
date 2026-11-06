# Beam — ETHGlobal submission assets

**Your screen. Your wallet. Your call.**

An Android wallet that floats over any app. Tap the beam on any screen — a chat, an email, an invoice — and pay the amount and recipient you already see, in **USDC on Arc**, with **ENS** names, **World ID** approvals, scam checks, and **AI agents you approve over MCP**.

---

## Short description (one line)

Beam is a floating Android wallet that turns payment details on any screen into a reviewed USDC payment on Arc — with ENS recipients, World ID approvals, and MCP agents that can only ask, never spend.

## The problem

Paying from crypto today means leaving the conversation: copy an address, switch to a wallet, paste, hope you got it right. Addresses are unreadable, screens can lie, and "agentic" wallets quietly hand bots the keys.

## What Beam does

- **Pay in place.** A floating button over any app reads the visible amount and recipient on demand. You review, then confirm with your fingerprint.
- **Names, not hex.** Pay an **ENS** name; Beam re-resolves it on your phone. Claim your own `name.beamfi.eth` subname (ENS v2).
- **A human in the loop.** **World ID** gates over-cap, first-time and agent payments. The **BeamPay** contract on Arc verifies an EIP-712 approval before it moves funds.
- **Agents that ask, not spend.** Connect **Claude Code** or **Codex** over hosted **MCP** (streamable HTTP, one URL). They propose; the payment opens on your phone for your World ID approval.
- **Safety before you send.** Scam Shield flags urgency, secret-phrase and pay-to-receive traps. A prompt-injection guard means screen text or agent instructions can't redirect a payment.
- **Spending limits.** An onchain per-payment cap and a daily limit, enforced by the contract.

## Tracks

- **Arc** — Best DeFi / onchain finance app built end to end (BeamPay settles USDC on Arc).
- **ENS** — Best use of ENSv2 (per-name Permissioned Resolver subnames under `beamfi.eth`).
- **World ID** — human approval gating risky and agent-initiated payments.

## Tech

- **App:** Expo / React Native (Android), floating overlay + accessibility screen reader.
- **Server:** Hono (Node); agent planner; hosted MCP over streamable HTTP.
- **Contract:** BeamPay (Foundry, Solidity 0.8.24) on Arc — forwards USDC, emits receipts, verifies EIP-712 World ID approvals, enforces caps.
- **Identity:** ENS v2 on Sepolia; World ID v4.

## Links

- **Repo:** https://github.com/kartikmehta8/beam
- **Website:** see `website/` (deploys to Vercel)
- **Demo video:** `video/beam-demo.mp4`

## Assets in this folder

| Path | What |
|------|------|
| `logo/beam-mark.svg`, `logo/beam-logo-1024.png` | App logo (blue mark) |
| `logo/beam-glyph.svg` | Glyph only |
| `logo/ens.svg`, `logo/world.svg` | Partner marks used in the product |
| `images/cover.png`, `images/og.png` | 1200×630 cover / Open Graph image |
| `images/twitter.png` | 1200×630 Twitter card |
| `screenshots/*.png` | Website / product screenshots |
| `video/beam-demo.mp4` | 3–3.5 min end-to-end demo |
