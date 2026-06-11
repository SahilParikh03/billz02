/**
 * Prepaid credit top-up endpoint (Phase C).
 *
 * POST /api/credit/topup  { amount_usd }   header: X-Beamr-User: 0x…
 *
 * Turns the welcome-credit ledger into a real prepaid balance: a signed-in
 * wallet user pays USDC to the treasury over x402, and the settled amount is
 * added to their credit balance — the funding side of the credit lane the chat
 * endpoint spends from.
 *
 * The flow mirrors the seller-side chat paywall (reusing the SAME primitives in
 * `payment/seller.ts`; no new payment machinery):
 *   1. no X-PAYMENT          → 402 with the x402 `accepts` offer for `amount_usd`
 *   2. X-PAYMENT present      → verify → settle the exact amount → addCredit
 * Unlike inference there is no "work" to do, so settlement happens inline and
 * the credit is granted only after funds actually move.
 */

import { getConfig } from "@/lib/config";
import { addCredit, isWalletUser } from "@/lib/credit";
import { toAtomicUsdc } from "@/payment/quote";
import {
  buildPaymentRequirements,
  decodePaymentHeader,
  paymentRequiredBody,
  settlePayment,
  verifyPayment,
} from "@/payment/seller";

function err(message: string, type: string, status: number): Response {
  return Response.json({ error: { message, type } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const cfg = getConfig();

  // Credit is keyed by wallet address — only signed-in wallet users can top up.
  const userId = request.headers.get("x-beamr-user")?.trim();
  if (!isWalletUser(userId)) {
    return err(
      "X-Beamr-User must be a 0x-prefixed EVM wallet address",
      "invalid_request_error",
      400,
    );
  }

  let body: { amount_usd?: unknown };
  try {
    body = (await request.json()) as { amount_usd?: unknown };
  } catch {
    return err("invalid JSON body", "invalid_request_error", 400);
  }

  const amountUsd = Number(body.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return err("amount_usd must be a positive number", "invalid_request_error", 400);
  }

  const atomicUsdc = toAtomicUsdc(amountUsd);
  if (atomicUsdc <= BigInt(0)) {
    // Rounds below 1 atomic unit (1e-6 USDC) — nothing to settle.
    return err("amount_usd is below the minimum (1e-6)", "invalid_request_error", 400);
  }

  // buildPaymentRequirements throws if BEAMR_SELL_PAY_TO (the treasury) is unset.
  let reqs;
  try {
    reqs = buildPaymentRequirements(cfg, {
      atomicUsdc,
      resource: new URL(request.url).pathname,
      description: `BEAMR credit top-up ($${amountUsd})`,
    });
  } catch {
    return err(
      "treasury misconfigured: BEAMR_SELL_PAY_TO is unset",
      "server_error",
      500,
    );
  }

  // 1. No payment yet → advertise the price.
  const payload = decodePaymentHeader(request.headers.get("x-payment"));
  if (!payload) {
    return Response.json(paymentRequiredBody(reqs, "payment required"), { status: 402 });
  }

  // 2. Verify the signed payment before crediting.
  const verdict = await verifyPayment(cfg, payload, reqs);
  if (!verdict.ok || !verdict.facilitator) {
    return Response.json(
      paymentRequiredBody(reqs, `payment invalid: ${verdict.reason ?? "unknown"}`),
      { status: 402 },
    );
  }

  // Settle (move the exact authorized USDC) BEFORE crediting — never grant
  // balance for funds that didn't actually move.
  const settled = await settlePayment(verdict.facilitator, payload, reqs);
  if (!settled.success) {
    return err(
      `settlement failed: ${settled.error ?? "unknown"}`,
      "payment_error",
      402,
    );
  }

  // The exact settled amount (exact scheme = maxAmountRequired) becomes credit.
  const credited = Number(atomicUsdc) / 1e6;
  const balance = await addCredit(userId!, credited);

  const headers: Record<string, string> = {};
  if (settled.header) headers["X-PAYMENT-RESPONSE"] = settled.header;

  return Response.json(
    { ok: true, credited, balance, txHash: settled.txHash ?? null },
    { headers },
  );
}
