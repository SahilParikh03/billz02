# BEAMR

A consumer-facing AI inference router that pays model providers per call over the
**x402** protocol (gasless USDC on Base). You talk to it like any chat app; under
the hood it routes each request to a provider, pays for it, and shows you every
charge in a **live spend feed**.

This repo implements **Stages 0–3** of the plan in [`../beamr_prd.md`](../beamr_prd.md)
(mock-verified; live mainnet pieces pending — see [SETUP.md](./SETUP.md)).

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
- **Multi-provider + shared state (Stage 2)**: Venice + Hyperbolic + **Surplus
  Intelligence** (flat $0.003306/call). Per-user daily budgets and a pluggable
  shared store (in-memory default, Upstash-Redis adapter) so caps hold across
  serverless instances. Wallet-provider abstraction (`key` | CDP server wallet).
- **Learning loop (Stage 3)**: thumbs-up/down (`POST /api/feedback`) become learned
  quality priors that bias routing toward what users prefer per task class — the
  asset competitors can't copy. Forkable **policy modes** (frugal / balanced /
  premium / uncensored), a quality-per-dollar **leaderboard** (`GET /api/leaderboard`),
  and a `train` CLI that exports the preference dataset.

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
| `npm run train` | Aggregate `.beamr/feedback.jsonl` → leaderboard + dataset export |
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
    store.ts          ← pluggable async KV (in-memory | Upstash Redis)
    events.ts         ← in-process spend-event bus
    quality.ts        ← learned quality priors (feedback → win-rates)
    feedback.ts       ← trace→context capture + submitFeedback + JSONL log
    ids.ts
  providers/
    index.ts          ← registry: mock | (venice + hyperbolic + surplus)
    mock.ts           ← offline simulated provider
    venice.ts         ← OpenAI-compatible, credit-balance
    hyperbolic.ts     ← per-call x402 USDC settlement
    surplus.ts        ← flat-price x402 ($0.003306/call)
  policy/
    classify.ts       ← difficulty / task-class / output-length classifier
    score.ts          ← tier + cost/quality scoring (blends learned quality)
    modes.ts          ← forkable policy presets
    select.ts         ← classify → policy → cascade → best in tier
  payment/
    wallet.ts         ← x402 Signer; "key" | "cdp" (server wallet)
    facilitator.ts    ← facilitator URL + settlement-receipt decode
    budget.ts         ← store-backed per-session + per-user caps
  pipeline/
    cache.ts          ← two-layer semantic cache (exact + embedding cosine)
    embed.ts          ← local zero-dependency embedder (MiniLM-swappable)
    execute.ts        ← cache → route → budget → stream → record → publish → failover
    log.ts            ← structured per-call log + JSONL replay
  eval/ab.test.ts     ← router vs always-strong A/B (cost-per-query)
  app/
    api/v1/chat/completions/route.ts   ← OpenAI-compatible entrypoint
    api/{feed,feedback,leaderboard,models,health}/route.ts
    page.tsx + components/             ← talk-to-it UI, spend feed, thumbs
scripts/train.mjs     ← offline: feedback.jsonl → leaderboard + dataset export
```

## Verified vs. not

**Verified** (locally, mock mode unless noted): typecheck, lint, **198 tests**,
production build, HTTP smoke tests (the 402 budget cap; the
trace→feedback→leaderboard loop; `/api/readiness`; the embedded-wallet credit
grant + gating), an A/B benchmark showing ~71% cost reduction (cascade + cache),
and a unit proof that feedback shifts routing. The **MiniLM** embedder was
verified live (model download → 384-d; a near-duplicate prompt served free from
cache at cosine 0.96, end-to-end).

**Not yet verifiable** (needs live CDP creds + mainnet USDC — see
[RUNBOOK.md](./RUNBOOK.md)): real on-chain x402 settlement and CDP MPC signing,
the CDP embedded-wallet email→OTP round-trip, and Venice's production x402
credit-balance top-up + `X-Sign-In-With-X` (SIWE) handshake (stubbed as a TODO;
an optional `VENICE_API_KEY` Bearer token is the interim path).

## Roadmap

**Stages 0–3 + classifier tune + mainnet hardening + embedded wallets + MiniLM are
built and merged.** The hardening is code-complete and env-guarded: real CDP
server-wallet signer, CDP facilitator selection + failover, shared Redis budgets/
cache, per-user credit, and a `/api/readiness` go-live gate. What remains is
**live verification on mainnet** (real CDP creds + USDC) — the procedure is in
[RUNBOOK.md](./RUNBOOK.md); testnet setup is in [SETUP.md](./SETUP.md). Details in
`../beamr_prd.md`.
