# BILLZ — Mainnet Go-Live Runbook

How to take BILLZ live on **Base mainnet** with real USDC settlement, and how to
operate, monitor, and roll it back. This is the mainnet counterpart to
[SETUP.md](./SETUP.md) (which covers the testnet path). Everything here maps to
flags and endpoints that already exist in the code — nothing new to build.

> **Status honesty.** The mainnet settlement path (real CDP signing + on-chain
> USDC) is **code-complete and env-guarded but has not been exercised against a
> live facilitator with real funds.** This runbook *is* the procedure to do that
> safely. Treat the first live calls as a verification, not a launch.

---

## 0. What "live" changes

In mock mode the whole pipeline runs offline on a simulated provider. Flipping to
live (`BILLZ_PROVIDER_MODE=live`, `BILLZ_NETWORK=base`) changes three things:

| Concern | Mock / testnet | Mainnet |
| --- | --- | --- |
| Providers | `mock` only | Venice + Hyperbolic + Surplus (real x402) |
| Money | none | **real USDC on Base** (6-decimal, `0x8335…2913`) |
| Wallet | none / testnet key | CDP MPC server wallet (recommended) |
| Facilitator | public `x402.org` | CDP facilitator (OFAC/KYT, SLA) |
| State | process-local Maps | Upstash Redis (budgets + cache shared) |

The single source of truth for "are we ready?" is **`GET /api/readiness`** — it
returns `200` with `liveReady:true` only when there are no hard blockers, else
`503` with a `blockers[]` list. Use it as the deploy gate.

---

## 1. Pre-flight checklist (accounts + funds)

- [ ] **Coinbase Developer Platform** project at `portal.cdp.coinbase.com`
  - [ ] API key → `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`
  - [ ] Wallet secret → `CDP_WALLET_SECRET`
  - [ ] Embedded-wallet project id (for email signup) → `NEXT_PUBLIC_CDP_PROJECT_ID`,
        and add the production origin to the project's **allowed domains**
- [ ] **Upstash Redis** database (REST) → `REDIS_URL`, `REDIS_TOKEN`
- [ ] **Mainnet USDC** to fund the router wallet (buy on Coinbase; bridge to Base)
- [ ] A little **ETH on Base** for the wallet (CDP sponsors gas, but keep a buffer)
- [ ] Hosting on a commercial tier (Vercel **Pro** — Hobby is non-commercial and
      its 100k-invocation cap is hit fast with SSE)

---

## 2. Provision CDP (wallet + facilitator + embedded wallets)

One CDP project covers all three. From `portal.cdp.coinbase.com`:

1. **Server wallet** (the router's hot wallet, MPC custody, no key at rest):
   set `BILLZ_WALLET_PROVIDER=cdp` and the three `CDP_*` secrets. On first boot
   the app calls `getOrCreateAccount({ name: CDP_WALLET_NAME })` (default
   `billz-router`) — **reuse the same `CDP_WALLET_NAME` across deploys** so the
   funded account is reloaded, not recreated.
2. **Facilitator**: setting `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` *automatically*
   selects the Coinbase-hosted facilitator (`api.cdp.coinbase.com/platform/v2/x402`)
   over the public one — OFAC/KYT screening on every settlement, **1,000 tx/mo
   free then $0.001/tx**, gas sponsored. No extra flag.
3. **Embedded wallets** (email signup): set `NEXT_PUBLIC_CDP_PROJECT_ID`. Without
   it the app runs anonymous-only (per-session budget) — see §8.

> **Custody note.** `BILLZ_WALLET_PROVIDER=key` (raw `WALLET_PRIVATE_KEY`) works
> on mainnet but is flagged as a warning by `/api/readiness`. Use it only for a
> short, low-cap canary; move to `cdp` before any real volume.

---

## 3. Provision Redis (shared budgets + cache)

Budgets are **correctness-critical**: without a shared store, each serverless
instance keeps its own counters and the per-session/$ per-user caps don't hold
globally. Set `REDIS_URL` + `REDIS_TOKEN` (Upstash REST; `UPSTASH_REDIS_REST_URL`
/ `_TOKEN` are also accepted). `/api/readiness` pings the store and **blocks
go-live if a configured shared store is unreachable**.

The semantic cache also write-throughs its exact layer to Redis when configured,
so identical prompts hit across instances. Upstash free tier = 10k commands/day;
size up if you exceed it.

---

## 4. Environment configuration

Set these in the host's env (Vercel project settings → mark secrets as secret;
**never commit**). Full template + comments live in `.env.example`.

### Required for mainnet

```bash
BILLZ_PROVIDER_MODE=live
BILLZ_NETWORK=base

# Wallet (recommended: CDP MPC server wallet)
BILLZ_WALLET_PROVIDER=cdp
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
CDP_WALLET_NAME=billz-router      # reuse across deploys

# Shared state
REDIS_URL=https://...upstash.io
REDIS_TOKEN=...

# Spend caps (start conservative — see §6 canary)
BILLZ_SESSION_BUDGET_USD=1
BILLZ_MAX_PAYMENT_PER_CALL_USD=0.02
BILLZ_USER_DAILY_BUDGET_USD=1     # 0 disables the per-user/day cap
```

### Recommended / optional

```bash
NEXT_PUBLIC_CDP_PROJECT_ID=...    # email signup + embedded wallets
BILLZ_WELCOME_CREDIT_USD=1        # one-time test credit per new wallet
BILLZ_FALLBACK_FACILITATORS=https://...   # comma-sep failover after CDP
BILLZ_RPC_URL=https://...         # private Base RPC (avoid public rate limits)
VENICE_API_KEY=...                # until Venice SIWE top-up lands (see SETUP.md)
SURPLUS_BASE_URL=https://www.surplusintelligence.ai/x402/api/inference/v1
BILLZ_EMBEDDER=minilm             # higher-quality cache matching (downloads model)
```

Leave `X402_FACILITATOR_URL` at its default; with CDP creds set it's only used as
the first failover entry behind the CDP facilitator.

---

## 5. Fund the router wallet

1. Get the wallet address. For the **CDP** provider, the address is logged on
   first boot and shown in the CDP portal under the `billz-router` account; for
   the **key** provider, derive it:
   ```bash
   node -e 'import("viem/accounts").then(({privateKeyToAccount})=>{require("dotenv").config({path:".env.local"});console.log(privateKeyToAccount(process.env.WALLET_PRIVATE_KEY).address)})'
   ```
2. Send **mainnet USDC** (contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
   6 decimals) on **Base** to that address. Start small — enough for the canary
   (e.g. $5–$20). Add a little ETH for headroom.
3. Confirm the balance on Basescan before proceeding.

---

## 6. Deploy + verify (the gate)

Deploy (`vercel --prod`, or push & deploy via the dashboard) with the §4 env set.
Then **gate on readiness** — do not announce until this is green:

```bash
# Must return HTTP 200 and liveReady:true with empty blockers[].
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR_HOST/api/readiness
curl -s https://YOUR_HOST/api/readiness | jq '{liveReady, blockers, warnings, wallet, facilitator, store}'
```

Expected on a correct mainnet config:

```json
{
  "liveReady": true,
  "blockers": [],
  "warnings": [],
  "wallet": { "provider": "cdp", "configured": true },
  "facilitator": { "kind": "cdp", "url": "https://api.cdp.coinbase.com/platform/v2/x402" },
  "store": { "id": "redis", "shared": true, "reachable": true }
}
```

If `liveReady:false`, fix every line in `blockers[]` (each names the missing
flag). Common ones:
- `BILLZ_PROVIDER_MODE is not 'live'` → set it to `live`.
- `CDP wallet creds incomplete …` → set all three `CDP_*` secrets.
- `shared store 'redis' is unreachable …` → check `REDIS_URL`/`REDIS_TOKEN`.

`warnings[]` are advisory, not blocking (e.g. still on the public facilitator, or
using the raw-key wallet on mainnet). Aim to clear them before real volume.

### First live settlement (canary)

With caps low (§4), send one real call and watch it settle on-chain:

```bash
curl -s -X POST https://YOUR_HOST/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"stream":false,"messages":[{"role":"user","content":"In one sentence, what is Base?"}]}' | jq .
```

- Expect ~1–2 s before the answer (CDP facilitator settles in ~2 s; only
  Flashblocks facilitators approach ~0.2 s).
- Open the app's **spend feed** (or `GET /api/feed` SSE): the event should show
  the real provider, a non-zero `usdcCharged`, and a `settlementTxHash`. Verify
  that tx on Basescan.
- Re-send the **same** prompt → it should come back **free** (`cacheHit:true`,
  `usdcCharged:0`) from the semantic cache.
- Send a prompt that exceeds the session cap → **HTTP 402** `budget_exceeded`.

Once a real tx confirms on-chain and the 402 cap fires, settlement is verified.
Raise `BILLZ_SESSION_BUDGET_USD` / `BILLZ_MAX_PAYMENT_PER_CALL_USD` gradually.

---

## 7. Embedded-wallet (email signup) check

If `NEXT_PUBLIC_CDP_PROJECT_ID` is set:
- The header shows **Sign in** (not the "Guest" chip). Email → OTP → signed-in
  shows the embedded-wallet address + remaining test credit.
- On sign-in the app calls `POST /api/account`, which idempotently grants
  `BILLZ_WELCOME_CREDIT_USD` once. Verify:
  ```bash
  curl -s "https://YOUR_HOST/api/account?user=0xWALLET" | jq .   # {balance, granted}
  ```
- Signed-in chat sends `X-Billz-User: <address>`; calls deplete that wallet's
  credit and return **402 `credit exhausted`** when it hits 0 (independent of the
  per-session cap). Anonymous users are unaffected.

---

## 8. Monitoring & alerts

| Signal | Where | Alert on |
| --- | --- | --- |
| Live-readiness | `GET /api/readiness` (200/503) | any `503`, or new `blockers[]` |
| Service health | `GET /api/health` | non-200; unexpected `providerMode`/`facilitator.kind` |
| Per-call spend | spend feed / `GET /api/feed` (SSE) | `usdcCharged` outliers; missing `settlementTxHash` |
| Wallet balance | Basescan / CDP portal | USDC below a top-up threshold |
| Quality/cost | `GET /api/leaderboard` | win-rate or quality-per-dollar regressions |
| Facilitator usage | CDP portal | approaching the 1,000 free tx/mo |
| Redis | Upstash console | approaching 10k commands/day; errors |

Point an uptime monitor at `/api/readiness` so a degraded config (e.g. Redis went
unreachable) pages instead of silently dropping budget enforcement.

---

## 9. Rollback / kill switch

Fastest to slowest, all without a code deploy:

1. **Stop spending immediately** — set `BILLZ_PROVIDER_MODE=mock` and redeploy
   env (or restart). All calls become free simulated responses; `/api/readiness`
   goes `503`. No wallet or chain interaction.
2. **Throttle** — drop `BILLZ_MAX_PAYMENT_PER_CALL_USD` and
   `BILLZ_SESSION_BUDGET_USD` / `BILLZ_USER_DAILY_BUDGET_USD` to clamp blast radius.
3. **Cut a provider** — if one upstream misbehaves, the router already fails over
   across providers; to force it off, remove its creds/URL.
4. **Wallet containment** — with the CDP server wallet, rotate the wallet secret /
   spend policy in the CDP portal; with a raw key, move funds out and swap
   `WALLET_PRIVATE_KEY`.

The session budget (default in code) and per-call max are the structural
backstops: even with no human in the loop, a single session can't exceed its cap
and a single call can't exceed `BILLZ_MAX_PAYMENT_PER_CALL_USD` (enforced as the
x402 `maxValue` the signer will authorize).

---

## 10. Incident playbook

- **Facilitator down / settlements failing.** Add alternates to
  `BILLZ_FALLBACK_FACILITATORS` (CDP → xpay → OpenZeppelin Relayer); the chain is
  tried in order. If all fail, roll back to mock (§9.1).
- **Spend higher than expected.** Check the leaderboard + feed for a provider
  pricing surprise; lower the per-call max; verify the cache is hitting (a low
  hit-rate inflates cost — confirm `BILLZ_EMBEDDER` and `BILLZ_CACHE_SIM_THRESHOLD`).
- **Budget not holding across instances.** `/api/readiness.store.shared` is
  `false` → Redis isn't wired; set `REDIS_URL`/`REDIS_TOKEN`. Until then, pin to a
  single instance.
- **Wallet draining.** Throttle (§9.2), then containment (§9.4). Per-call max is
  your hard ceiling per request.
- **Embedded-wallet sign-in failing.** Confirm `NEXT_PUBLIC_CDP_PROJECT_ID` and
  that the production origin is in the CDP project's allowed domains.

---

## 11. Cost & limits reference

- **CDP facilitator:** 1,000 settlements/mo free, then **$0.001/tx**; gas sponsored.
- **CDP wallet ops:** 5,000/mo free, then $0.005/op.
- **Upstash Redis:** 10k commands/day free tier.
- **Surplus Intelligence:** flat **$0.003306 USDC/call** (Base mainnet).
- **Hyperbolic:** dynamic price, discovered from the 402 challenge per call.
- **Settlement latency:** ~2 s (CDP); ~0.2 s only on Flashblocks-enabled facilitators.
- **USDC (Base mainnet):** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals).

---

## 12. Security notes

- Secrets (`WALLET_PRIVATE_KEY`, all `CDP_*`, `REDIS_TOKEN`, `VENICE_API_KEY`) live
  only in server env — never in the client bundle. The only public-by-design var
  is `NEXT_PUBLIC_CDP_PROJECT_ID` (a project id, not a secret).
- `/api/readiness` and `/api/health` report **presence/shape** of config, never
  secret values.
- The CDP facilitator screens every settlement for OFAC/KYT — a reason to clear
  the "public facilitator" warning before real volume.
- Prefer the CDP MPC server wallet so there is **no plaintext private key at rest**
  in serverless env.
```
