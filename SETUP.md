# Going live (testnet) — manual steps

Stage 0 ships in **mock mode** so it runs with zero setup. To exercise the *real*
x402 payment path on Base Sepolia, do the following. These steps need a browser /
wallet and can't be automated, so they're listed for you to run.

## 1. Fund the router hot wallet

A throwaway testnet wallet was generated into `.env.local` as
`WALLET_PRIVATE_KEY`. Its address was printed when the project was created; to
re-derive it:

```bash
node -e 'import("viem/accounts").then(({privateKeyToAccount})=>{require("dotenv").config({path:".env.local"});console.log(privateKeyToAccount(process.env.WALLET_PRIVATE_KEY).address)})'
```

Fund that address on **Base Sepolia**:
- **USDC:** https://faucet.circle.com — switch network to Base Sepolia, claim 20 USDC (repeatable every 2h).
- **ETH (gas):** https://portal.cdp.coinbase.com → Faucets → Base Sepolia → 0.1 ETH.
  (With the public facilitator gas is sponsored, but a little ETH avoids edge cases.)

## 2. (Optional) Venice API key

The production Venice path (x402 credit-balance top-up + `X-Sign-In-With-X` SIWE
header) is **not implemented yet** (TODO, marked in `src/providers/venice.ts`).
For now, the simplest working Venice path is a Bearer key:

- Get a key at https://venice.ai and set `VENICE_API_KEY=...` in `.env.local`.
- Without it, Venice requests will 401 in live mode — Hyperbolic is the real
  x402 path for Stage 0; Venice can stay mock-only until Stage 1.

## 3. Flip to live mode

In `.env.local`:

```
BILLZ_PROVIDER_MODE=live
```

Then `npm run dev`. Watch the terminal and the spend feed. The first Hyperbolic
call probes the 402 response to discover the price (Hyperbolic does not publish a
fixed per-call price), signs a USDC `transferWithAuthorization`, and settles via
the facilitator at `X402_FACILITATOR_URL` (default `https://x402.org/facilitator`).

**Expect** ~1–2 s of settlement latency before tokens stream (the public/CDP
facilitator settles in ~2 s; only Flashblocks-enabled facilitators hit ~0.2 s).

## 4. Deploy to Vercel

```bash
vercel           # or push the repo and import it in the Vercel dashboard
```

Set environment variables in the Vercel project settings (do **not** commit them):
`BILLZ_PROVIDER_MODE`, `WALLET_PRIVATE_KEY` (mark as a secret),
`BILLZ_NETWORK`, `X402_FACILITATOR_URL`, `BILLZ_SESSION_BUDGET_USD`,
`BILLZ_MAX_PAYMENT_PER_CALL_USD`, and `VENICE_API_KEY` if used.

Notes:
- Vercel **Hobby is non-commercial only**; the moment you have paying users, move
  to **Pro** (you'll also hit Hobby's 100k-invocation limit fast with SSE).
- The spend feed bus and session budget are **process-local** in Stage 0, so they
  don't span multiple serverless instances. Single-instance / `next dev` is fine
  for demos; Stage 2 moves them to Redis.

## 5. Going to mainnet

The mainnet hardening listed here as future work is now **built** — CDP server
wallet + CDP facilitator + failover, shared Redis budgets/cache, per-user credit,
and a `/api/readiness` go-live gate. The full mainnet procedure (provision,
configure, fund, deploy, verify, monitor, roll back) is in
**[RUNBOOK.md](./RUNBOOK.md)**.
