/**
 * Browser credit top-up flow (Phase D) — the two-step x402 handshake.
 *
 * Step 1: POST /api/credit/topup with no payment → the server answers 402 with
 *         an x402 offer (`accepts[0]` = PaymentRequirements for `amount_usd`).
 * Step 2: sign that offer with the embedded wallet (via {@link cdpX402Account} +
 *         x402's own `createPaymentHeader`) and POST again with the X-PAYMENT
 *         header → the server verifies, settles on-chain, and credits the user.
 *
 * Pure and injectable (the signer and `fetch` are parameters), so it carries the
 * whole flow without React and is unit-testable end-to-end against the real
 * x402 encoder + the server's decoder.
 */

import { createPaymentHeader } from "x402/client";
import { cdpX402Account, type SignEvmTypedData } from "@/payment/cdpSigner";
import type { TopUpResult } from "./account";

const ENDPOINT = "/api/credit/topup";
const X402_VERSION = 1;

/** Pull a message out of either error envelope the endpoint can return. */
function readError(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const e = (data as { error?: unknown }).error;
    if (typeof e === "string") return e; // x402 402 body: { error: "payment invalid: …" }
    if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
      return (e as { message: string }).message; // { error: { message, type } }
    }
  }
  return undefined;
}

export async function runTopUp(
  address: string,
  signEvmTypedData: SignEvmTypedData,
  amountUsd: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TopUpResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Beamr-User": address,
  };
  const body = JSON.stringify({ amount_usd: amountUsd });

  // ── Step 1: request the x402 offer ──────────────────────────────────────────
  const quoteRes = await fetchImpl(ENDPOINT, { method: "POST", headers, body });
  if (quoteRes.status !== 402) {
    // 400 (bad wallet/amount) or 500 (treasury) — surface the server's reason.
    const data = await quoteRes.json().catch(() => undefined);
    return { ok: false, error: readError(data) ?? `top-up unavailable (${quoteRes.status})` };
  }

  const offer = (await quoteRes.json().catch(() => ({}))) as { accepts?: unknown[] };
  const requirements = offer.accepts?.[0];
  if (!requirements) {
    return { ok: false, error: "malformed payment offer from server" };
  }

  // ── Step 2: sign the offer with the embedded wallet ─────────────────────────
  let xPayment: string;
  try {
    const account = cdpX402Account(address, signEvmTypedData);
    xPayment = await createPaymentHeader(account as never, X402_VERSION, requirements as never);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not sign the payment" };
  }

  // ── Step 3: re-POST with payment → verify + settle + credit ─────────────────
  const payRes = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { ...headers, "X-PAYMENT": xPayment },
    body,
  });
  const data = (await payRes.json().catch(() => ({}))) as {
    ok?: boolean;
    credited?: number;
    balance?: number;
    txHash?: string | null;
  };
  if (!payRes.ok || !data.ok) {
    return { ok: false, error: readError(data) ?? `payment failed (${payRes.status})` };
  }

  return {
    ok: true,
    credited: data.credited,
    balance: data.balance,
    txHash: data.txHash ?? null,
  };
}
