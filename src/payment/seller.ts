// x402 names this `useFacilitator`, but it is a plain factory (verify/settle),
// not a React hook — alias it so the react-hooks lint rule doesn't misfire.
import { useFacilitator as facilitatorClient } from "x402/verify";
import { getDefaultAsset, safeBase64Decode } from "x402/shared";
import {
  PaymentPayloadSchema,
  settleResponseHeader,
  type FacilitatorConfig,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type Resource,
} from "x402/types";
import type { AppConfig } from "@/lib/types";
import { resolveSell } from "@/lib/config";
import { facilitatorChain } from "./facilitator";

/**
 * Seller-side x402 primitives (Phase 1).
 *
 * The mirror of the buyer flow in `payment/wallet.ts` + `payment/facilitator.ts`:
 * here BEAMR is the *resource server*. It (1) advertises a price as
 * `PaymentRequirements`, (2) verifies a buyer's signed `X-PAYMENT` header
 * against a facilitator *before* doing any work, and (3) settles the exact
 * amount *after* the work succeeds, emitting an `X-PAYMENT-RESPONSE` receipt.
 *
 * Verify and settle both run through `useFacilitator`, which delegates the
 * onchain work to the configured facilitator (CDP when creds are present, else
 * the public one) — reusing `facilitatorChain` for the same failover ordering
 * the buyer side already trusts.
 */

const X402_VERSION = 1;

// ── Payment requirements (the 402 offer) ──────────────────────────────────────

/**
 * Build the `exact`-scheme `PaymentRequirements` BEAMR advertises for a call.
 * Asset + EIP-712 domain come from x402's default-asset table for the network
 * (USDC on Base / Base-Sepolia), so we never hardcode a token address.
 *
 * @throws if `cfg.sell.payTo` is unset — the caller must guard this first.
 */
export function buildPaymentRequirements(
  cfg: AppConfig,
  opts: { atomicUsdc: bigint; resource: string; description: string },
): PaymentRequirements {
  const sell = resolveSell(cfg);
  if (!sell.payTo) {
    throw new Error(
      "payment/seller.buildPaymentRequirements: cfg.sell.payTo is unset " +
        "(set BEAMR_SELL_PAY_TO to the recipient address).",
    );
  }
  const asset = getDefaultAsset(cfg.network as Network);
  return {
    scheme: "exact",
    network: cfg.network as PaymentRequirements["network"],
    maxAmountRequired: opts.atomicUsdc.toString(),
    resource: opts.resource as Resource,
    description: opts.description,
    mimeType: "application/json",
    payTo: sell.payTo,
    maxTimeoutSeconds: sell.maxTimeoutSeconds,
    asset: String(asset.address),
    extra: asset.eip712,
  };
}

/** The JSON body of a 402 response: x402 version + the offers + an error note. */
export function paymentRequiredBody(
  reqs: PaymentRequirements,
  error = "payment required",
): { x402Version: number; error: string; accepts: PaymentRequirements[] } {
  return { x402Version: X402_VERSION, error, accepts: [reqs] };
}

// ── Decode the buyer's X-PAYMENT header ───────────────────────────────────────

/**
 * Decode + schema-validate the `X-PAYMENT` request header (base64 JSON) into a
 * `PaymentPayload`. Returns null on a missing, malformed, or schema-invalid
 * header so callers can answer 402 without try/catch.
 */
export function decodePaymentHeader(
  header: string | null | undefined,
): PaymentPayload | null {
  if (!header) return null;
  try {
    const json = JSON.parse(safeBase64Decode(header));
    const parsed = PaymentPayloadSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── Verify (before work) ──────────────────────────────────────────────────────

export interface VerifyOutcome {
  ok: boolean;
  payer?: string;
  /** The facilitator that accepted the payment — reuse it to settle. */
  facilitator?: FacilitatorConfig;
  reason?: string;
}

/**
 * Verify a signed payment against the requirements. Walks `facilitatorChain`
 * and returns on the first facilitator that reports `isValid`; a facilitator
 * that throws is treated as a soft failure and the next one is tried.
 *
 * Verification does NOT move funds — it only checks the signature, amount,
 * recipient, and balance. Settlement is a separate, later step.
 */
export async function verifyPayment(
  cfg: AppConfig,
  payload: PaymentPayload,
  reqs: PaymentRequirements,
): Promise<VerifyOutcome> {
  let reason: string | undefined;
  for (const facilitator of facilitatorChain(cfg)) {
    try {
      const { verify } = facilitatorClient(facilitator);
      const res = await verify(payload, reqs);
      if (res.isValid) return { ok: true, payer: res.payer, facilitator };
      reason = res.invalidReason ?? "invalid_payment";
    } catch {
      reason = "facilitator_error";
    }
  }
  return { ok: false, reason };
}

// ── Settle (after work) ───────────────────────────────────────────────────────

export interface SettleOutcome {
  success: boolean;
  /** Value for the `X-PAYMENT-RESPONSE` response header, when settled. */
  header?: string;
  txHash?: string;
  error?: string;
}

/**
 * Settle the (already-verified) payment through the facilitator that accepted
 * it, moving the exact authorized amount. Returns the encoded
 * `X-PAYMENT-RESPONSE` header on success.
 *
 * Called only on the success path, *after* the completion is produced — a
 * failed or budget-rejected generation never reaches settlement, so the buyer
 * is never charged for work they didn't receive.
 */
export async function settlePayment(
  facilitator: FacilitatorConfig,
  payload: PaymentPayload,
  reqs: PaymentRequirements,
): Promise<SettleOutcome> {
  try {
    const { settle } = facilitatorClient(facilitator);
    const res = await settle(payload, reqs);
    if (res.success) {
      return {
        success: true,
        header: settleResponseHeader(res),
        txHash: res.transaction,
      };
    }
    return { success: false, error: res.errorReason ?? "settle_failed" };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
