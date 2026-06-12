# BEAMR — Mainnet Go-Live Runbook

How to take BEAMR live on **Base mainnet** with real USDC settlement, and how to
operate, monitor, and roll it back. This is the mainnet counterpart to
[SETUP.md](./SETUP.md) (which covers the testnet path). Everything here maps to
flags and endpoints that already exist in the code — nothing new to build.

> **Status honesty.** The mainnet settlement path (in-process viem signing +
> on-chain USDC) is **code-complete and env-guarded but has not been exercised
> against real funds.** This runbook *is* the procedure to do that safely. Treat
> the first live calls as a verification, not a launch.

> **Phase E note.** Settlement is fully **off Coinbase**: BEAMR settles x402
> payments **in-process with viem** against the USDC contract (`localFacilitator`).
> There is no CDP server wallet and no hosted facilitator — the router private
> key is the only signer, and it pays the gas. Top-ups come from two user rails:
> a self-custody wallet (wagmi) and Stripe card.

---

## 0. What "live" changes

In mock mode the whole pipeline runs offline on a simulated provider. Flipping to
live (`BEAMR_PROVIDER_MODE=live`, `BEAMR_NETWORK=base`) changes:

| Concern | Mock / testnet | Mainnet |
| --- | --- | --- |
| Providers | `mock` only | Venice + Hyperbolic + Surplus (real x402) |
| Money | none | **real USDC on Base** (6-decimal, `0x8335…2913`) |
| Wallet | none / testnet key | funded router key (`WALLET_PRIVATE_KEY`) |
| Settlement | n/a | **in-process viem** (`localFacilitator`) — router broadcasts, pays gas |
| State | process-local Maps | Upstash Redis (budgets + cache + webhook dedupe shared) |

The single source of truth for "are we ready?" is **`GET /api/readiness`** — it
returns `200` with `liveReady:true` only when there are no hard blockers, else
`503` with a `blockers[]` list. Use it as the deploy gate.

---

## 1. Pre-flight checklist (accounts + funds)

- [ ] **Router wallet** — a fresh EVM keypair; put the 0x private key in
      `WALLET_PRIVATE_KEY` (treat as a secret). This one wallet pays upstream
      providers AND broadcasts settlement.
- [ ] **A dedicated Base RPC** (Alchemy/Infura/QuickNode/etc.) → `BEAMR_RPC_URL`.
      The public RPC is rate-limited and will throttle settlement under load.
- [ ] **Mainnet USDC** to fund the router wallet (the credit it sells), plus
      **ETH on Base for gas** — the router pays its own gas now (no sponsorship).
- [ ] **Stripe account** (for the card rail) → `STRIPE_SECRET_KEY`,
      `STRIPE_WEBHOOK_SECRET` (from a configured webhook endpoint).
- [ ] **WalletConnect project id** (optional, for the WalletConnect connector) →
      `NEXT_PUBLIC_WALLETCONNECT_ID` (from cloud.reown.com).
- [ ] **Upstash Redis** database (REST) → `REDIS_URL`, `REDIS_TOKEN`.
- [ ] Hosting on a commercial tier (Vercel **Pro** — Hobby is non-commercial and
      its 100k-invocation cap is hit fast with SSE).

---

## 2. Provision the RPC + Stripe

1. **RPC**: create a Base **mainnet** endpoint and set `BEAMR_RPC_URL`. The
   in-process facilitator uses it for `verifyTypedData`, `balanceOf`,
   `authorizationState`, and broadcasting `transferWithAuthorization`. Without it
   viem falls back to the chain's public RPC (fine for a canary, rate-limited for
   volume — `/api/readiness` warns on mainnet when it's unset).
2. **Stripe** (card rail): in the Stripe Dashboard create a webhook endpoint at
   `https://YOUR_HOST/api/credit/stripe/webhook` subscribed to
   `checkout.session.completed`; copy its signing secret to
   `STRIPE_WEBHOOK_SECRET` and your API secret key to `STRIPE_SECRET_KEY`. The
   browser only ever sees a redirect to hosted Checkout — there is no publishable
   key and no client Stripe SDK.

> **Custody note.** The router key is a raw hot key. Keep its balance to roughly
> what you're comfortable losing, top it up from Stripe payouts, and rotate it if
> exposed. There is no MPC/KMS layer in this build.

---

## 3. Provision Redis (shared budgets + cache + webhook dedupe)

Budgets are **correctness-critical**: without a shared store, each serverless
instance keeps its own counters and the per-session/$ per-user caps don't hold
globally. The Stripe webhook's idempotency marker (`stripe:evt:<id>`) also lives
here — on a single in-memory instance a redelivered event is still deduped, but
across instances you need Redis so a replay can't double-credit. Set `REDIS_URL`
+ `REDIS_TOKEN` (Upstash REST; `UPSTASH_REDIS_REST_URL` / `_TOKEN` also accepted).
`/api/readiness` pings the store and **blocks go-live if a configured shared
store is unreachable**.

---

## 4. Environment configuration

Set these in the host's env (Vercel project settings → mark secrets as secret;
**never commit**). Full template + comments live in `.env.example`.

### Required for mainnet

```bash
BEAMR_PROVIDER_MODE=live
BEAMR_NETWORK=base
NEXT_PUBLIC_BEAMR_NETWORK=base     # client mirror so the wallet rail defaults to Base

# Router wallet — the only signer/settler (pays providers AND broadcasts settlement)
WALLET_PRIVATE_KEY=0x...
BEAMR_RPC_URL=https://base-mainnet...   # dedicated RPC; avoids public rate limits

# Card rail (Stripe)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Shared state
REDIS_URL=https://...upstash.io
REDIS_TOKEN=...

# Spend caps (start conservative — see §6 canary)
BEAMR_SESSION_BUDGET_USD=1
BEAMR_MAX_PAYMENT_PER_CALL_USD=0.02
BEAMR_USER_DAILY_BUDGET_USD=1     # 0 disables the per-user/day cap
```

### Recommended / optional

```bash
NEXT_PUBLIC_WALLETCONNECT_ID=...  # enables the WalletConnect connector (mobile)
BEAMR_WELCOME_CREDIT_USD=1        # one-time test credit per new identity
VENICE_API_KEY=...                # until Venice SIWE top-up lands (see SETUP.md)
SURPLUS_BASE_URL=https://www.surplusintelligence.ai/x402/api/inference/v1
BEAMR_EMBEDDER=minilm             # higher-quality cache matching (downloads model)
```

---

## 5. Fund the router wallet

1. Derive the wallet address from the key:
   ```bash
   node -e 'import("viem/accounts").then(({privateKeyToAccount})=>{require("dotenv").config({path:".env.local"});console.log(privateKeyToAccount(process.env.WALLET_PRIVATE_KEY).address)})'
   ```
2. Send **mainnet USDC** (contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
   6 decimals) on **Base** to that address — this is the inventory the credit
   lane spends. Also send **ETH on Base for gas** (the router pays gas on every
   settlement now). Start small — enough for the canary (e.g. $5–$20 + a little ETH).
3. Confirm the balances on Basescan before proceeding.

> Wallet-rail top-ups land USDC in the treasury (`BEAMR_SELL_PAY_TO`); card-rail
> revenue lands as fiat in Stripe. Keep the router funded with USDC + ETH by
> sweeping from the treasury and topping up from Stripe payouts (operational, not
> automated by this build).

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
  "wallet": { "provider": "key", "configured": true },
  "facilitator": { "kind": "local", "rpc": "https://base-mainnet..." },
  "store": { "id": "redis", "shared": true, "reachable": true }
}
```

If `liveReady:false`, fix every line in `blockers[]` (each names the missing
flag). Common ones:
- `BEAMR_PROVIDER_MODE is not 'live'` → set it to `live`.
- `WALLET_PRIVATE_KEY is not set …` → set the router key.
- `shared store 'redis' is unreachable …` → check `REDIS_URL`/`REDIS_TOKEN`.

`warnings[]` are advisory, not blocking (e.g. no dedicated `BEAMR_RPC_URL`, or a
process-local store on mainnet). Aim to clear them before real volume.

### First live settlement (canary)

With caps low (§4), top up via the wallet rail and watch it settle on-chain:
connect MetaMask on Base, click `$1`, sign one EIP-3009 authorization. The router
broadcasts `transferWithAuthorization`; the response carries the `txHash` —
verify it on Basescan. Then send a chat message and watch the spend feed
(`GET /api/feed` SSE) show the real provider + a non-zero `usdcCharged`. Re-send
the same prompt → it should come back **free** (`cacheHit:true`). A prompt over
the cap → **HTTP 402**.

For the card rail, run `stripe listen --forward-to localhost:3000/api/credit/stripe/webhook`
in dev (or point a real webhook at prod), sign in with email, click `$5`, pay
with test card `4242 4242 4242 4242` → the webhook credits the ledger; replaying
the event credits **once**.

Once a real tx confirms on-chain and the 402 cap fires, settlement is verified.
Raise `BEAMR_SESSION_BUDGET_USD` / `BEAMR_MAX_PAYMENT_PER_CALL_USD` gradually.

---

## 7. Top-up rails (wallet + card) check

No env gate any more — the **Add credit** control always renders:
- **Wallet rail.** "Connect a wallet" lists the available connectors (injected,
  and WalletConnect when `NEXT_PUBLIC_WALLETCONNECT_ID` is set). After connecting,
  the identity is the `0x…` address; `$1/$5/$20` sign an x402 top-up.
- **Card rail.** "Continue with email" creates an `email:<lowercased>` identity
  (persisted in `localStorage`); `$1/$5/$20` open Stripe Checkout.
- On either sign-in the app calls `POST /api/account`, which idempotently grants
  `BEAMR_WELCOME_CREDIT_USD` once. Verify:
  ```bash
  curl -s "https://YOUR_HOST/api/account?user=0xWALLET" | jq .          # wallet id
  curl -s "https://YOUR_HOST/api/account?user=email:a%40b.com" | jq .   # email id
  ```
- Signed-in chat sends `X-Beamr-User: <id>`; calls deplete that identity's credit
  and return **402** when it hits 0 (independent of the per-session cap).
  Anonymous users are unaffected.

---

## 8. Monitoring & alerts

| Signal | Where | Alert on |
| --- | --- | --- |
| Live-readiness | `GET /api/readiness` (200/503) | any `503`, or new `blockers[]` |
| Service health | `GET /api/health` | non-200; unexpected `providerMode`/`facilitator.kind` |
| Per-call spend | spend feed / `GET /api/feed` (SSE) | `usdcCharged` outliers; missing `settlementTxHash` |
| Router USDC | Basescan | USDC below a top-up threshold (out of inventory) |
| Router ETH (gas) | Basescan | ETH low — settlement broadcasts will start to fail |
| Stripe | Stripe Dashboard → Webhooks | failed deliveries / signature errors on the webhook |
| Quality/cost | `GET /api/leaderboard` | win-rate or quality-per-dollar regressions |
| Redis | Upstash console | approaching 10k commands/day; errors |

Point an uptime monitor at `/api/readiness` so a degraded config (e.g. Redis went
unreachable) pages instead of silently dropping budget enforcement.

---

## 9. Rollback / kill switch

Fastest to slowest, all without a code deploy:

1. **Stop spending immediately** — set `BEAMR_PROVIDER_MODE=mock` and redeploy
   env (or restart). All calls become free simulated responses; `/api/readiness`
   goes `503`. No wallet or chain interaction.
2. **Throttle** — drop `BEAMR_MAX_PAYMENT_PER_CALL_USD` and
   `BEAMR_SESSION_BUDGET_USD` / `BEAMR_USER_DAILY_BUDGET_USD` to clamp blast radius.
3. **Cut a provider** — if one upstream misbehaves, the router already fails over
   across providers; to force it off, remove its creds/URL.
4. **Wallet containment** — move funds out of the router wallet and rotate
   `WALLET_PRIVATE_KEY`. Pause the card rail by unsetting `STRIPE_SECRET_KEY`
   (checkout starts to 500 cleanly).

The session budget (default in code) and per-call max are the structural
backstops: even with no human in the loop, a single session can't exceed its cap
and a single call can't exceed `BEAMR_MAX_PAYMENT_PER_CALL_USD` (enforced as the
x402 `maxValue` the signer will authorize).

---

## 10. Incident playbook

- **Settlements failing.** The facilitator is in-process now, so check the RPC
  first: a bad/rate-limited `BEAMR_RPC_URL`, or the router out of **ETH for gas**.
  `verify` soft-fails to `unexpected_verify_error` and `settle` to
  `unexpected_settle_error` on RPC errors — both surface in the feed/logs. If the
  RPC is the issue, swap `BEAMR_RPC_URL`; if it's gas, top up ETH. Roll back to
  mock (§9.1) if it persists.
- **Card credits not landing.** Check Stripe → Webhooks for failed deliveries or
  signature errors (`STRIPE_WEBHOOK_SECRET` mismatch). A duplicate delivery is
  expected to no-op (idempotent); a missing credit is usually a webhook the
  endpoint never received or a signature failure (returns 400).
- **Spend higher than expected.** Check the leaderboard + feed for a provider
  pricing surprise; lower the per-call max; verify the cache is hitting (a low
  hit-rate inflates cost — confirm `BEAMR_EMBEDDER` and `BEAMR_CACHE_SIM_THRESHOLD`).
- **Budget not holding across instances.** `/api/readiness.store.shared` is
  `false` → Redis isn't wired; set `REDIS_URL`/`REDIS_TOKEN`. Until then, pin to a
  single instance.
- **Wallet draining.** Throttle (§9.2), then containment (§9.4). Per-call max is
  your hard ceiling per request.

---

## 11. Cost & limits reference

- **Settlement gas:** paid by the router in ETH on Base (cheap, but non-zero —
  keep an ETH buffer). No facilitator fee — settlement is in-process.
- **Stripe:** standard card fees (~2.9% + $0.30) on each card top-up; revenue
  lands as fiat in Stripe, not USDC.
- **Upstash Redis:** 10k commands/day free tier.
- **Surplus Intelligence:** flat **$0.003306 USDC/call** (Base mainnet).
- **Hyperbolic:** dynamic price, discovered from the 402 challenge per call.
- **Settlement latency:** one tx + receipt wait on Base (~2 s; faster on
  Flashblocks-enabled RPCs).
- **USDC (Base mainnet):** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals).

---

## 12. Security notes

- Secrets (`WALLET_PRIVATE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `REDIS_TOKEN`, `VENICE_API_KEY`) live only in server env — never in the client
  bundle. The only public-by-design vars are `NEXT_PUBLIC_WALLETCONNECT_ID` and
  `NEXT_PUBLIC_BEAMR_NETWORK` (a project id and a network name, not secrets).
- `/api/readiness` and `/api/health` report **presence/shape** of config, never
  secret values.
- The Stripe webhook verifies every event's signature against the **raw body**
  before crediting; an unsigned or tampered body is rejected with 400.
- The router key is a hot key with no MPC/KMS layer — keep its balance modest,
  rotate on exposure, and prefer a dedicated wallet that only does settlement.
```
