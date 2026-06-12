# beamr-gateway

Route an agent's LLM calls through **BEAMR** — an OpenAI-compatible inference
router that pays providers **per call** over **x402** (gasless USDC on Base) —
and pay BEAMR the same way. No API key: a funded wallet is the credential.

## What this is

BEAMR sits one layer above raw providers. For each request it classifies
difficulty, picks the cheapest capable provider (Venice / Hyperbolic / Surplus /
…), pays that single call onchain, and exposes the whole thing as a standard
`POST /v1/chat/completions` endpoint. With its **seller paywall** enabled, BEAMR
also *charges the caller* per call using the x402 `exact` scheme — so an agent
pays a fraction of a cent in USDC and gets an onchain settlement receipt back.

For an agent framework that already routes LLM traffic through gateways (Aeon's
`Surplus`, `Venice`, `OpenRouter`, `Bankr`, …), BEAMR is a drop-in gateway that
adds a **policy/routing layer** and **x402 metering end-to-end**:

```
agent ──x402 pay──▶ BEAMR (classify + route) ──x402 pay──▶ cheapest provider
                          │
                          └─ returns OpenAI-shaped completion + X-PAYMENT-RESPONSE receipt
```

## When to use

- You want pay-per-call LLM inference settled in **USDC on Base**, with **bounded
  per-call spend** (a hard ceiling enforced by the payer wallet), instead of a
  prepaid API key.
- You want a router to pick the cheapest capable model automatically (`model:
  "auto"`) rather than pinning one provider.
- You're wiring an agent (Aeon skill, A2A/MCP tool, CLI) that already holds a Base
  wallet and wants onchain receipts per inference call.

## Requirements

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `BEAMR_GATEWAY_URL` | yes | — | Base URL of the BEAMR deployment (e.g. `https://app.beamr.sh`). |
| `PAYER_PRIVATE_KEY` | yes | — | `0x`-hex key of a wallet funded with USDC on the target network. |
| `BEAMR_NETWORK` | no | `base-sepolia` | `base` for mainnet. Must match the gateway's network. |
| `BEAMR_MODEL` | no | `auto` | A specific model id, or `auto` to let BEAMR's router choose. |
| `BEAMR_POLICY` | no | — | Policy mode: `frugal` \| `balanced` \| `premium` \| `uncensored`. |
| `BEAMR_MAX_PAY_USDC` | no | `0.10` | Per-call spend ceiling; an offer above this throws (never overpays). |
| `BEAMR_SYSTEM` | no | — | Optional system prompt. |

This skill has no install step beyond Node ≥ 18 (for global `fetch`) and the
`x402-fetch` package, which provides the buyer-side payment handshake.

## Usage

```bash
export BEAMR_GATEWAY_URL="https://app.beamr.sh"
export PAYER_PRIVATE_KEY="0x..."          # funded with USDC on Base
export BEAMR_NETWORK="base"               # or base-sepolia for testnet

# prompt as an argument…
node scripts/beamr-chat.mjs "Summarize the x402 spec in two sentences."

# …or piped on stdin (chains cleanly from another skill)
echo "Draft a tweet about gasless agent payments." | node scripts/beamr-chat.mjs
```

The completion is written to **stdout** (clean, pipeable). Routing + settlement
metadata — model chosen, token usage, trace id, and the onchain **tx hash** from
the `X-PAYMENT-RESPONSE` receipt — go to **stderr** as a `[beamr] {…}` line.

## How payment works (x402 `exact`)

1. Client `POST`s the chat request with **no** payment header.
2. BEAMR replies **`402 Payment Required`** with an `accepts: [PaymentRequirements]`
   offer (price in atomic USDC, `payTo`, asset, EIP-712 domain).
3. `wrapFetchWithPayment` checks the price is within `BEAMR_MAX_PAY_USDC`, signs
   an `X-PAYMENT` authorization with the payer wallet, and **retries**.
4. BEAMR **verifies** the signature against a facilitator *before* doing work,
   runs the completion, then **settles** the exact amount and returns the
   completion + an `X-PAYMENT-RESPONSE` receipt. A failed generation is **never**
   charged (settlement happens only on success).

Funds never move for cache hits or when the paywall is disabled — the client
handles all three (paid / free / cached) transparently.

## Notes & limits

- **Non-streaming only** in the current BEAMR paywall phase: the client always
  sends `stream: false`. (Free, unmetered streaming still works if the gateway's
  paywall is off.)
- The `BEAMR_NETWORK` of this client **must match** the gateway's
  `BEAMR_NETWORK`; a mismatch fails verification.
- The spend ceiling is enforced **client-side** by the payer wallet, independent
  of any cap BEAMR advertises — set it to bound a runaway agent.

## Files

- `scripts/beamr-chat.mjs` — runnable buyer-side x402 client (depends on `x402-fetch`).
