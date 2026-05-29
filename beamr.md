# BEAMR — Handoff / Source of Truth

> This file is the canonical reference for what BEAMR is, how it's built, and where
> the work stands. Read it first. The deeper research dossier is `../beamr_prd.md`;
> testnet bring-up is `SETUP.md`; mainnet go-live is `RUNBOOK.md`.

---

## 1. What BEAMR is

A **consumer-facing AI inference router** that pays model providers **per call** over
the **x402 protocol** — gasless USDC on **Base**. You talk to it like any chat app;
under the hood it classifies each request, routes it to the cheapest provider that
can handle it, pays for that single call on-chain, and shows you every charge in a
**live spend feed**.

The thesis: the **moat is the policy layer** (routing + the feedback-learned quality
priors), not the payment plumbing. Providers are deliberately pluggable — adding one
is a single file implementing `ProviderAdapter`.

**Status (2026-05-29):** Stages 0–3 + classifier tune + mainnet hardening + embedded
wallets + MiniLM swap + go-live runbook are **all built, verified locally, and merged
to `main`** (FF history; HEAD `866512d`). The **only** thing not done is **live
mainnet settlement verification**, which is externally blocked on real CDP credentials
+ mainnet USDC. `RUNBOOK.md` is the exact procedure to perform it.

---

## 2. How a request flows

`POST /api/v1/chat/completions` (OpenAI-compatible, streaming SSE) →
`pipeline/execute.ts::executeChat`, which is the spine. In order:

0. **Cache lookup** — two-layer semantic cache (`pipeline/cache.ts`). A hit is
   streamed back **free**, bypassing both routing and budget.
1. **Route** (`policy/select.ts`) — classify difficulty/task-class → strong/weak
   cascade → cheapest candidate in the chosen tier (cost + optional latency/quality
   weights). Explicit model ids are honored; `auto`/absent lets the router choose.
2. **Budget pre-check** — session cap (and per-user daily cap) checked *before*
   streaming. Over-budget → `HTTP 402`. Signed-in wallet users additionally must have
   welcome credit (`credit exhausted` → 402).
3. **Stream** from the chosen adapter, forwarding `delta` events. On adapter error,
   **failover** to the next active provider (a failed call is never charged).
4. **On done** — record spend, deplete wallet credit, publish a `SpendEvent` to the
   feed, capture routing context (for Stage-3 feedback labeling), record cost, and
   **store the result in the cache**.

The cross-module contract for all of this is **`src/lib/types.ts`** — `ProviderAdapter`,
`StreamEvent`, `CompletionResult`, `SpendEvent`, `RouteDecision`, `AppConfig`, etc.
Nothing outside that file should need to change to add a provider.

---

## 3. Architecture map

```
src/
  lib/
    types.ts        ← THE shared contract (read this to understand the system)
    config.ts       ← env → AppConfig, read at REQUEST time (not build time)
    store.ts        ← pluggable async KV: in-memory default | Upstash Redis REST
                      (+ ping() and isSharedStore() for readiness/shared-cache)
    events.ts       ← in-process spend-event bus (SSE source)
    quality.ts      ← learned quality priors (feedback → per-taskclass win-rates)
    feedback.ts     ← trace→context capture + submitFeedback + JSONL log
    credit.ts       ← store-backed welcome-credit ledger (wallet users)
    readiness.ts    ← go-live gate: hard blockers + soft warnings (no secrets)
    ids.ts
  providers/
    index.ts        ← registry: mock | (venice + hyperbolic + surplus)
    mock.ts         ← fully offline simulated provider (default)
    venice.ts       ← OpenAI-compatible, credit-balance (prod SIWE handshake = TODO)
    hyperbolic.ts   ← per-call x402 USDC (price discovered from the 402 response)
    surplus.ts      ← flat-price x402 ($0.003306/call, Base mainnet)
  policy/
    classify.ts     ← difficulty / task-class / output-length classifier
    score.ts        ← tier + cost/quality scoring (blends learned quality priors)
    modes.ts        ← forkable policy presets (frugal/balanced/premium/uncensored)
    select.ts       ← classify → policy → cascade → best-in-tier
  payment/
    wallet.ts       ← x402 Signer: "key" (private key) | "cdp" (MPC server wallet)
    facilitator.ts  ← facilitator selection (CDP|public) + failover + receipt decode
    budget.ts       ← store-backed per-session + per-user/day caps (ASYNC)
  pipeline/
    cache.ts        ← two-layer cache (exact FNV-1a + embedding cosine), shared-store write-through
    embed.ts        ← pluggable embedder: local zero-dep | MiniLM (384-d)
    execute.ts      ← the spine (section 2 above)
    log.ts          ← structured per-call log + JSONL replay
  components/
    BeamrApp.tsx, ChatPanel, SpendFeed, Header, useChat/useSession/useSpendFeed/…
    cdp/            ← embedded-wallet UI (CdpProvider, CdpRoot, CdpAccountSync,
                      AuthMenu, account.ts/useAccount)
  app/
    page.tsx        ← <CdpProvider><BeamrApp/></CdpProvider>
    api/v1/chat/completions/route.ts   ← OpenAI-compatible entrypoint
    api/{feed,feedback,leaderboard,models,health,readiness,account}/route.ts
scripts/train.mjs   ← offline: feedback.jsonl → leaderboard + dataset export
```

---

## 4. Stage-by-stage (what each milestone added)

- **Stage 0** — OpenAI-compatible streaming endpoint; mock + live provider modes;
  $5 session budget → 402; live spend feed (SSE); throwaway testnet wallet.
- **Stage 1** — in-process difficulty classifier → strong/weak cascade + cost
  scoring → two-layer semantic cache. A/B harness (`npm run eval`) shows **~71%**
  cost reduction vs always-strong in mock mode.
- **Stage 2** — pluggable async `Store` (in-memory | Upstash Redis) backing the
  budget; per-user daily caps (`X-Beamr-User`); **Surplus Intelligence** as a 3rd
  live provider; wallet-provider abstraction (`key` | `cdp`). Budget fns are async.
- **Stage 3** — feedback→routing learning loop: thumbs (`POST /api/feedback`) →
  learned quality priors (`lib/quality.ts`) blended into scoring; routing context
  captured per `traceId`; forkable policy modes; quality-per-dollar leaderboard
  (`GET /api/leaderboard`); `npm run train` exports the preference dataset.
- **Classifier tune** — added an `f_taskclass` intrinsic-difficulty term
  (code/reasoning hard, creative mid, chat easy) + re-centered logistic (K=4.8,
  X0=0.365) + trivial ceiling 0.18. Difficulty now spreads trivial<0.2 → hard>0.75
  and policy modes actually diverge. (Resolved the old "everything rates hard" bug.)
- **Mainnet hardening** (code-complete, env-guarded) — real CDP **MPC server-wallet**
  signer (`getSignerCdp()` via `@coinbase/cdp-sdk`, lazy import); CDP **facilitator**
  selection via `@coinbase/x402` with public fallback + `facilitatorChain()` failover;
  `Store.ping()` + shared-store **write-through exact-cache** layer; `lib/readiness.ts`
  + `GET /api/readiness` (200 liveReady / 503, blockers + warnings, **never** secrets).
- **Embedded wallets** (code-complete) — email signup via CDP embedded wallets
  (`@coinbase/cdp-hooks`/`-core`). `CdpProvider` degrades to anonymous when
  `NEXT_PUBLIC_CDP_PROJECT_ID` is unset; else dynamically (ssr:false) mounts the SDK.
  `CdpAccountSync` bridges the SDK onto an `Account` context (`useAccount()`);
  `AuthMenu` runs email→OTP→signed-in. Signed-in address → `X-Beamr-User` → per-user
  budget + feedback. Server `lib/credit.ts` is a store-backed, idempotent welcome-credit
  ledger; `POST/GET /api/account` grants/reads the one-time $1; `executeChat` gates
  wallet users on credit and depletes per call. Anonymous session users untouched.
- **MiniLM swap** (code-complete + **live-verified**) — semantic-cache embedder is
  pluggable via `BEAMR_EMBEDDER` (`local` default | `minilm` = all-MiniLM-L6-v2 384-d
  via `@huggingface/transformers`, an optionalDependency + `serverExternalPackages`).
  Verified live this env: 384-d, near-dup cosine 0.957 / unrelated −0.066, and a
  near-dup prompt served from cache at sim 0.96 end-to-end. Opt-in test: `BEAMR_TEST_MINILM=1`.
- **Go-live runbook** — `RUNBOOK.md`: provisioning (CDP wallet+facilitator+embedded,
  Redis), full mainnet env, fund router wallet, deploy gated on `/api/readiness`,
  canary, monitoring, kill-switch/rollback, incident playbook, cost/limits.

---

## 5. Configuration (env vars)

All config is read at **request time** by `getConfig()` (`src/lib/config.ts`) — Next 16
does not bundle runtime config. Defaults shown.

**Core**
- `BEAMR_PROVIDER_MODE` — `mock` (default, fully offline) | `live` (Venice+Hyperbolic+Surplus)
- `BEAMR_NETWORK` — `base-sepolia` (default) | `base`
- `BEAMR_SESSION_BUDGET_USD` — `5`
- `BEAMR_USER_DAILY_BUDGET_USD` — `0` (0 disables the per-user/day cap)
- `BEAMR_WELCOME_CREDIT_USD` — `1` (one-time credit for new signed-in wallet users)
- `BEAMR_MAX_PAYMENT_PER_CALL_USD` — `0.1`

**Routing / cache**
- `BEAMR_DIFFICULTY_THRESHOLD` — `0.5` · `BEAMR_LATENCY_WEIGHT` — `0` · `BEAMR_QUALITY_WEIGHT` — `0`
- `BEAMR_CACHE_ENABLED` — `true` · `BEAMR_CACHE_SIM_THRESHOLD` — `0.83` ·
  `BEAMR_CACHE_TTL_MS` — `86400000` · `BEAMR_CACHE_MAX_ENTRIES` — `500`
- `BEAMR_EMBEDDER` — `local` (default) | `minilm` · `BEAMR_MINILM_MODEL` — `Xenova/all-MiniLM-L6-v2`

**Payment / providers**
- `WALLET_PRIVATE_KEY` — `0x…` throwaway hot wallet (key signer path)
- `X402_FACILITATOR_URL` — `https://x402.org/facilitator` (public default)
- `BEAMR_WALLET_PROVIDER` — `key` | `cdp` · `BEAMR_FALLBACK_FACILITATORS` — comma-separated
- CDP server wallet: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`,
  `CDP_WALLET_NAME` (default `beamr-router`)
- `VENICE_API_KEY` (interim Bearer), `VENICE_BASE_URL`, `HYPERBOLIC_X402_URL`

**Embedded wallets (client)**
- `NEXT_PUBLIC_CDP_PROJECT_ID` — public-by-design project id; unset → anonymous mode

**Shared store (Redis)**
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (unset → in-memory store)

---

## 6. HTTP surface

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/chat/completions` | OpenAI-compatible chat (SSE). Headers: `X-Beamr-Session`, `X-Beamr-User`, `X-Beamr-Policy`, `X-Beamr-Trace` |
| `GET /api/feed` | Live spend feed (SSE) |
| `POST /api/feedback` | Thumbs up/down by `traceId` |
| `GET /api/leaderboard` | Quality-per-dollar leaderboard |
| `GET /api/models` | Available models |
| `GET /api/health` | Mode, network, walletProvider, facilitator {kind,url}, store {id,shared} |
| `GET /api/readiness` | Go-live gate — 200 if `liveReady`, else 503 + blockers/warnings (no secrets) |
| `POST /api/account` `{address}` | Grant one-time welcome credit · `GET ?user=0x…` reads status |

---

## 7. Scripts & verification

| Command | What |
|---|---|
| `npm run dev` | Dev server (Turbopack). **Port 3000 is held by an unrelated app on this box — use `PORT=3100`** |
| `npm run build` / `npm start` | Production build / serve |
| `npm test` | Vitest — **198 tests** (mock mode), +1 opt-in live MiniLM (`BEAMR_TEST_MINILM=1`) |
| `npm run eval` | Router-vs-always-strong A/B (cost-per-query) → ~71% cheaper |
| `npm run train` | `.beamr/feedback.jsonl` → leaderboard + dataset export |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

**Verified locally** (mock mode unless noted): typecheck, lint, 198 tests, prod build,
HTTP smoke tests (402 budget cap; trace→feedback→leaderboard loop; `/api/readiness`;
embedded-wallet credit grant + gating); A/B ~71% reduction; MiniLM verified live.

**Not yet verifiable** (needs live CDP creds + mainnet USDC): real on-chain x402
settlement + CDP MPC signing; CDP embedded-wallet email→OTP round-trip; Venice's
production x402 credit-balance top-up + `X-Sign-In-With-X` (SIWE) handshake (TODO —
`VENICE_API_KEY` Bearer is the interim path).

---

## 8. Sharp edges / things to know before you touch it

- **AGENTS.md is binding:** this is a **modified Next.js 16.2.6** with breaking
  changes. Read the bundled guide in `node_modules/next/dist/docs/01-app/` *before*
  writing any Next code. Don't trust training-data Next conventions.
- **`@supabase/ssr`-style inference traps don't apply here** — but the x402 type
  story does: `@coinbase/x402` ships a looser bundled `FacilitatorConfig`
  (`url: string|undefined`); cast `createFacilitatorConfig(...) as unknown as
  FacilitatorConfig`. Same pattern for the CDP account → x402 `Signer` cast.
- **Don't name a private field the same as a method** — the `store` field once
  shadowed the `store()` method in `TwoLayerCache` ("cache.store is not a function").
  The field is now `sharedStore`.
- **Everything mainnet is env-guarded** — with no CDP creds / Redis / `live` mode, the
  app runs exactly as the mock/testnet build. Adding mainnet features must preserve this.
- **Secrets stay server-side.** Only `NEXT_PUBLIC_CDP_PROJECT_ID` is public (a project
  id, not a secret). `/api/health` and `/api/readiness` report presence/shape only.
- **Use `PORT=3100`** — 3000 is occupied by an unrelated `node dist/server/server.js`.
- **Spend-bus + budget are process-local** unless a shared `Store` (Redis) is
  configured — fine for single-instance/demo, required for multi-instance serverless.

---

## 9. Git state

FF-only history on `main`. Milestone commits:

| Milestone | Commit |
|---|---|
| Stage 3 | (merged) |
| Classifier tune | `3161bb2` |
| Mainnet hardening (CDP wallet/facilitator/Redis) | `497ebed` |
| Embedded wallets (email signup + credit) | `42b801d` |
| MiniLM embedder | `aa45007` |
| Mainnet runbook + docs | `866512d` |

---

## 10. The one open item

**Live mainnet settlement verification** — externally blocked on real CDP credentials
+ mainnet USDC. `RUNBOOK.md` §6 is the procedure (fund router wallet → deploy gated on
`/api/readiness` → first-settlement canary on Basescan). Everything buildable and
locally verifiable in this repo is complete.

Constants worth keeping handy: **Base mainnet USDC** =
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Testnet hot wallet address (from
`.env.local`) = `0xdA02DDc98566B7FF1949603969e42D8F18089Fa8`.
