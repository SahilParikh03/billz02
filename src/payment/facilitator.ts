import { decodeXPaymentResponse } from "x402-fetch";

/**
 * Settlement-receipt decoding.
 *
 * In the buyer flow the upstream *resource server* (Hyperbolic / Surplus) runs
 * verify/settle against its own facilitator and returns an `X-PAYMENT-RESPONSE`
 * receipt; this module's only job is decoding that receipt.
 *
 * Phase E removed BEAMR's own use of a hosted facilitator: when BEAMR settles
 * (the seller-side paywall / credit top-up) it now does so in-process with viem
 * — see `payment/localFacilitator.ts`. No Coinbase service is contacted here and
 * `@coinbase/x402` is no longer imported. `decodeXPaymentResponse` is a pure,
 * offline base64-JSON decoder.
 */

/**
 * Decodes an `X-PAYMENT-RESPONSE` header value into a minimal receipt shape.
 *
 * `decodeXPaymentResponse` returns `{ success, transaction, network, payer }`.
 * NOTE: the amount is NOT in this receipt — capture it from the PaymentRequirements
 * your selector chose at request time.
 *
 * Tolerates a missing or malformed header by returning an empty object, so callers
 * never have to guard against `undefined` receipts.
 *
 * @param header - The raw `X-PAYMENT-RESPONSE` header string, or empty/undefined.
 * @returns `{ settlementTxHash }` when successful, or `{}` on any failure.
 */
export function decodeReceipt(header: string | null | undefined): {
  settlementTxHash?: string;
} {
  if (!header) return {};
  try {
    const decoded = decodeXPaymentResponse(header);
    if (decoded?.success && decoded.transaction) {
      return { settlementTxHash: decoded.transaction };
    }
    return {};
  } catch {
    return {};
  }
}
