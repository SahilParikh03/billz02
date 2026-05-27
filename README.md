# BILLZ

A consumer-facing AI inference router that pays model providers per call over the
**x402** protocol (gasless USDC on Base). You talk to it like any chat app; under
the hood it routes each request to a provider, pays for it, and shows you every
charge in a **live spend feed**.

This repo is **Stage 0** (testnet v1) of the plan in [`../billz_prd.md`](../billz_prd.md).

## What works today

- **OpenAI-compatible API** at `POST /api/v1/chat/completions` (streaming SSE).
- **Two provider modes**:
  - `mock` (default) — a fully offline simulated provider. The entire pipeline
    (routing → streaming → budget → live spend feed) runs with **no wallet and no
    network**, so you can demo and develop immediately.
  - `live` — real calls to **Hyperbolic** (per-call USDC via x402) and **Venice**
    (OpenAI-compatible credit-balance). See [SETUP.md](./SETUP.md) to go live.
- **Smart routing (Stage 1)**: an in-process difficulty classifier drives a
  strong/weak **cascade** — easy prompts go to the cheap tier, hard ones to the
  capable tier — with cost-based selection within the tier. Explicit models are
  honored; automatic **failover** on error (a failed call is never charged).
- **Semantic cache (Stage 1)**: exact + embedding-similarity cache; hits are
  served free (no spend, no provider call). Pluggable embedder — local
  zero-dependency default, MiniLM is a one-file swap.
- **A/B harness**: `npm run eval` measures router vs always-strong cost. Current
  mock-mode result: **~71% cheaper** over a 19-prompt mix (cascade + cache).
- **$5 per-session budget**, enforced before streaming. Over-budget requests get
  `HTTP 402` (fittingly, the x402 status).
- **Live spend feed** at `GET /api/feed` (SSE) → the talk-to-it UI renders each
  charge: provider, model, USDC, tokens, latency, payment mode, settlement tx,
  and a running burn-vs-budget bar.

## Quick start (mock mode — no setup)

```bash
npm run dev          # http://localhost:3000
```

`.env.local` is pre-generated with a throwaway testnet wallet and `mock` mode.
Open the app, chat, and watch the spend feed fill in with simulated charges.

> Port 3000 may be taken by another local service; `PORT=3100 npm run dev` works too.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` / `npm start` | Production build / serve |
| `npm test` | Unit + integration tests (Vitest, mock mode) |
| `npm run eval` | Router-vs-baseline A/B cost benchmark |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Architecture

The moat is the policy layer, not the plumbing — so providers are pluggable
(adding one = one file implementing `ProviderAdapter`). The cross-module contract
lives in `src/lib/types.ts`.

```
src/
  lib/
    types.ts          ← the shared contract (ProviderAdapter, SpendEvent, …)
    config.ts         ← env → AppConfig (read at request time)
    events.ts         ← in-process spend-event bus (Stage 0; Redis in Stage 2)
    ids.ts
  providers/
    index.ts          ← registry: mock | (venice + hyperbolic)
    mock.ts           ← offline simulated provider
    venice.ts         ← OpenAI-compatible, credit-balance
    hyperbolic.ts     ← per-call x402 USDC settlement
  policy/
    classify.ts       ← difficulty / task-class / output-length classifier
    score.ts          ← tier + cost/quality scoring of candidates
    select.ts         ← classify → strong/weak cascade → cheapest in tier
  payment/
    wallet.ts         ← viem/x402 Signer (live mode)
    facilitator.ts    ← facilitator URL + settlement-receipt decode
    budget.ts         ← per-session spend cap
  pipeline/
    cache.ts          ← two-layer semantic cache (exact + embedding cosine)
    embed.ts          ← local zero-dependency embedder (MiniLM-swappable)
    execute.ts        ← cache → route → budget → stream → record → publish → failover
    log.ts            ← structured per-call log + JSONL replay
  eval/
    ab.test.ts        ← router vs always-strong A/B (cost-per-query)
  app/
    api/v1/chat/completions/route.ts   ← OpenAI-compatible entrypoint
    api/feed/route.ts                  ← SSE spend feed
    api/models/route.ts, api/health/route.ts
    page.tsx + components/             ← talk-to-it UI + live spend feed
```

## Verified vs. not

**Verified** (locally, mock mode): typecheck, lint, 109 tests, production build, an
end-to-end smoke test of all four routes including the 402 budget cap, and an A/B
benchmark showing ~71% cost reduction from the cascade + cache.

**Not yet verifiable** (needs a funded wallet + live network — see SETUP.md):
the Hyperbolic 402 settlement cycle, the live `getSigner` path, and Venice's
production x402 credit-balance top-up + `X-Sign-In-With-X` (SIWE) handshake, which
is stubbed as a TODO (Stage 0 uses an optional `VENICE_API_KEY` Bearer token).

## Roadmap

**Stage 0 + Stage 1 are built.** Next: Stage 2 (mainnet — CDP facilitator, server
wallets, Redis-backed cache/budget) → Stage 3 (train a RouteLLM-style router on
your own thumbs-up/down data; swap the local embedder for MiniLM). Details in
`../billz_prd.md`.
