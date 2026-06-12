#!/usr/bin/env node
/**
 * beamr-chat — pay-per-call LLM inference through a BEAMR gateway over x402.
 *
 * BEAMR is an OpenAI-compatible inference router that classifies each request,
 * routes it to the cheapest capable provider, and (with its seller paywall on)
 * charges the caller per call in USDC on Base via the x402 `exact` scheme. From
 * an agent's point of view it is "an OpenAI endpoint that costs a fraction of a
 * cent per call and settles onchain" — no API key, just a funded wallet.
 *
 * This client does the buyer side of that handshake. `wrapFetchWithPayment`
 * (x402-fetch) makes the first request, catches the 402 + `accepts` offer,
 * signs an `X-PAYMENT` header within `BEAMR_MAX_PAY_USDC`, and retries — all
 * transparently. On success BEAMR returns the completion plus an
 * `X-PAYMENT-RESPONSE` settlement receipt, which we decode and print.
 *
 * NOTE: BEAMR's paywall meters the non-streaming path only (Phase 1), so this
 * always sends `stream: false`.
 *
 * Usage:
 *   node beamr-chat.mjs "Summarize the Base x402 spec in two sentences."
 *   echo "prompt on stdin" | node beamr-chat.mjs
 *
 * Required env:
 *   BEAMR_GATEWAY_URL   Base URL of the BEAMR gateway (e.g. https://app.beamr.sh)
 *   PAYER_PRIVATE_KEY   0x-hex private key of the funded payer wallet (USDC on Base)
 *
 * Optional env:
 *   BEAMR_NETWORK       "base" (mainnet) | "base-sepolia" (default)
 *   BEAMR_MODEL         model id, or "auto" (default) to let BEAMR's router choose
 *   BEAMR_POLICY        policy mode: frugal | balanced | premium | uncensored
 *   BEAMR_MAX_PAY_USDC  per-call spend cap in USDC (default 0.10) — a hard ceiling
 *   BEAMR_SYSTEM        optional system prompt
 */

import { createSigner, wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function die(msg) {
  console.error(`beamr-chat: ${msg}`);
  process.exit(1);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// USDC is 6-decimal: convert a USD cap to atomic base units for x402-fetch.
function usdcToAtomic(usd) {
  return BigInt(Math.round(Number(usd) * 1e6));
}

async function main() {
  const baseUrl = env("BEAMR_GATEWAY_URL");
  const privateKey = env("PAYER_PRIVATE_KEY");
  if (!baseUrl) die("BEAMR_GATEWAY_URL is required");
  if (!privateKey) die("PAYER_PRIVATE_KEY is required (funded wallet, USDC on Base)");

  const network = env("BEAMR_NETWORK", "base-sepolia");
  const model = env("BEAMR_MODEL", "auto");
  const policy = env("BEAMR_POLICY");
  const maxPayUsd = env("BEAMR_MAX_PAY_USDC", "0.10");
  const system = env("BEAMR_SYSTEM");

  const prompt = (process.argv.slice(2).join(" ").trim()) || (await readStdin());
  if (!prompt) die('no prompt — pass it as an argument or on stdin');

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  // Buyer-side x402: createSigner(network, privateKey) → wrapped fetch that
  // auto-pays any 402 whose price is <= the cap. The cap is a real ceiling:
  // an offer above it throws rather than silently overpaying.
  const signer = await createSigner(network, privateKey);
  const fetchWithPay = wrapFetchWithPayment(fetch, signer, usdcToAtomic(maxPayUsd));

  const url = new URL("/api/v1/chat/completions", baseUrl).toString();
  const headers = { "Content-Type": "application/json" };
  if (policy) headers["X-Beamr-Policy"] = policy;

  const res = await fetchWithPay(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, stream: false }),
  });

  const text = await res.text();
  if (!res.ok) {
    die(`gateway returned HTTP ${res.status}: ${text}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    die(`gateway returned non-JSON body: ${text.slice(0, 200)}`);
  }

  const content = body?.choices?.[0]?.message?.content ?? "";
  process.stdout.write(content + "\n");

  // Surface the settlement receipt + routing metadata on stderr so the answer
  // on stdout stays clean and pipeable.
  const receiptHeader = res.headers.get("x-payment-response");
  const receipt = receiptHeader ? decodeXPaymentResponse(receiptHeader) : null;
  const meta = {
    model: body?.model,
    usage: body?.usage,
    trace: res.headers.get("x-beamr-trace") || undefined,
    settlement: receipt
      ? { txHash: receipt.transaction, network: receipt.network, payer: receipt.payer }
      : "none (free path / cache hit / paywall disabled)",
  };
  console.error("[beamr] " + JSON.stringify(meta));
}

main().catch((e) => die(e?.message ?? String(e)));
