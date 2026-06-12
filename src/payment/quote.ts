import type { AppConfig, ChatMessage, Tier } from "@/lib/types";
import { resolveSell } from "@/lib/config";
import { classify } from "@/policy/classify";
import { estimateCostUsd } from "@/policy/score";
import { withMargin } from "./margin";

/**
 * Seller-side pricing (Phase A: cost-plus).
 *
 * BEAMR's realized provider cost is token-dependent and only known *after* the
 * call, but x402's `exact` scheme requires naming an exact price *before* the
 * buyer signs. So the quote is the *estimated* provider cost (from the same
 * classifier that drives routing) times the margin multiplier. Because the
 * buyer pre-pays against an estimate, the margin must also absorb estimation
 * error, and the price is clamped to `[floor, maxPaymentPerCallUsd]`:
 *
 *   - floor = the flat per-tier price. Never quote below the published flat
 *     rate (it's also the fallback when no price prior exists → estimate is 0).
 *   - cap   = `maxPaymentPerCallUsd`, bounding how far an estimate can overshoot.
 *
 * Net effect: cheap calls hold at the flat floor; an expensive turn whose
 * cost-plus exceeds the flat rate is charged its true cost-plus instead of
 * silently eroding margin.
 *
 * USDC is 6-decimal, so the atomic amount is `round(usd * 1e6)`.
 */

const USDC_DECIMALS = 6;

export interface PriceQuote {
  /** Price in USD. */
  usd: number;
  /** Price in atomic USDC units (6 dp) — the `maxAmountRequired` for x402. */
  atomicUsdc: bigint;
  /** Tier the classifier assigned; drives which flat price applies. */
  tier: Tier;
  /** Raw difficulty score (0..1), surfaced for transparency/logging. */
  difficulty: number;
}

/** Flat USD price for a tier, read from the seller config. */
export function quoteUsdForTier(tier: Tier, cfg: AppConfig): number {
  const sell = resolveSell(cfg);
  return tier === "strong" ? sell.priceStrongUsd : sell.priceWeakUsd;
}

/** Convert a USD amount to atomic USDC units (6 dp). */
export function toAtomicUsdc(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

/**
 * Price a request: classify → pick tier (same threshold as routing) →
 * cost-plus, clamped to `[flat-tier floor, maxPaymentPerCallUsd]`.
 * Pure and synchronous — no network, no settlement.
 */
export function priceQuote(messages: ChatMessage[], cfg: AppConfig): PriceQuote {
  const c = classify(messages);
  const tier: Tier =
    c.difficulty >= cfg.routing.difficultyThreshold ? "strong" : "weak";
  const floor = quoteUsdForTier(tier, cfg);
  // estimate is 0 when no price prior exists → costPlus collapses to the floor.
  const costPlus = withMargin(estimateCostUsd(messages, cfg), cfg);
  const usd = Math.min(Math.max(costPlus, floor), cfg.maxPaymentPerCallUsd);
  return { usd, atomicUsdc: toAtomicUsdc(usd), tier, difficulty: c.difficulty };
}
