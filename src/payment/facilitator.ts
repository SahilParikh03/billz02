import { decodeXPaymentResponse } from "x402-fetch";
import type { AppConfig } from "@/lib/types";

/**
 * Facilitator configuration + settlement-receipt helpers.
 *
 * Stage 0 uses the public facilitator and lets `x402-fetch` perform verify/settle
 * on the client side, so this module is intentionally thin: it centralizes the
 * facilitator URL and is the home for `decodeXPaymentResponse`-based receipt
 * parsing and multi-facilitator failover when we move to mainnet (Stage 2).
 */
export function facilitatorUrl(cfg: AppConfig): string {
  return cfg.facilitatorUrl;
}

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
