import { decodeXPaymentResponse } from "x402-fetch";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { FacilitatorConfig, Resource } from "x402/types";
import type { AppConfig } from "@/lib/types";

/**
 * Facilitator configuration + settlement-receipt helpers.
 *
 * In the buyer flow, the *resource server* (Hyperbolic / Surplus) runs verify
 * /settle against its own facilitator, so `x402-fetch` only signs on our side
 * and this module's job is (a) decoding settlement receipts and (b) producing
 * the x402 `FacilitatorConfig` BEAMR uses whenever it acts as the settling
 * party — e.g. a future BEAMR paywall that charges its own users, or a
 * server-side pre-settlement verify. Centralizing it here means the mainnet
 * switch (public → CDP facilitator) and multi-facilitator failover live in one
 * place.
 */

// ── Facilitator kind ──────────────────────────────────────────────────────────

/** Whether CDP-hosted facilitator credentials are present in the environment. */
export function cdpFacilitatorCredsPresent(): boolean {
  return Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
}

/**
 * Which facilitator is active given the environment:
 *  - "cdp"    Coinbase-hosted facilitator (JWT-authed; OFAC/KYT screening,
 *             1,000 free tx/mo). Selected when CDP API creds are set.
 *  - "public" the open `https://x402.org/facilitator` (or whatever
 *             X402_FACILITATOR_URL points at). The default for first wiring.
 */
export function facilitatorKind(): "cdp" | "public" {
  return cdpFacilitatorCredsPresent() ? "cdp" : "public";
}

// ── Facilitator config ──────────────────────────────────────────────────────

/**
 * The x402 `FacilitatorConfig` BEAMR should settle through.
 *
 * Returns the CDP-hosted config (with JWT `createAuthHeaders` derived from
 * `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`) when those creds are present, else a
 * plain `{ url }` pointing at the configured public facilitator.
 */
export function getFacilitatorConfig(cfg: AppConfig): FacilitatorConfig {
  if (cdpFacilitatorCredsPresent()) {
    // createFacilitatorConfig() reads the creds from the env when not passed,
    // but we pass them explicitly so the source of truth is unambiguous.
    // @coinbase/x402 ships its own (looser, `url: string | undefined`)
    // FacilitatorConfig type from a bundled @x402/core; it's structurally the
    // same shape, so cast through unknown to x402's stricter branded type.
    return createFacilitatorConfig(
      process.env.CDP_API_KEY_ID,
      process.env.CDP_API_KEY_SECRET,
    ) as unknown as FacilitatorConfig;
  }
  return { url: cfg.facilitatorUrl as Resource };
}

/**
 * Ordered facilitator failover chain. CDP is dominant and is a single-vendor
 * SPOF, so on mainnet we want to fall back to alternates. Order:
 *   1. the active facilitator (CDP when configured, else the primary url)
 *   2. the primary public url (when CDP is primary, this is the first fallback)
 *   3. any extra urls from BEAMR_FALLBACK_FACILITATORS (comma-separated)
 *
 * De-duplicated by url. Callers iterate this on settlement failure.
 */
export function facilitatorChain(cfg: AppConfig): FacilitatorConfig[] {
  const chain: FacilitatorConfig[] = [getFacilitatorConfig(cfg)];

  // When CDP is primary, the configured public url becomes the first fallback.
  if (cdpFacilitatorCredsPresent()) {
    chain.push({ url: cfg.facilitatorUrl as Resource });
  }

  const extra = (process.env.BEAMR_FALLBACK_FACILITATORS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const url of extra) chain.push({ url: url as Resource });

  // De-dupe by url, preserving order.
  const seen = new Set<string>();
  return chain.filter((c) => {
    const u = String(c.url);
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/**
 * The raw facilitator URL (string), for display/logging. Prefer
 * {@link getFacilitatorConfig} for anything that performs verify/settle.
 */
export function facilitatorUrl(cfg: AppConfig): string {
  return String(getFacilitatorConfig(cfg).url);
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
