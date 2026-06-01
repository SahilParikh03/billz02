import type { AppConfig, ChatMessage, Tier } from "@/lib/types";
import { resolveSell } from "@/lib/config";
import { classify } from "@/policy/classify";

/**
 * Seller-side pricing (Phase 1: flat per-tier).
 *
 * BEAMR's realized provider cost is token-dependent and only known *after* the
 * call, but x402's `exact` scheme requires naming an exact price *before* the
 * buyer signs. Phase 1 resolves this the simplest way that fits `exact`: a flat
 * price per policy tier (weak/strong), chosen by the same difficulty classifier
 * that drives routing. BEAMR absorbs the per-call variance; the margin covers
 * it. Phase 2 refines this into a classifier-estimated quote.
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
 * Price a request: classify → pick tier (same threshold as routing) → flat price.
 * Pure and synchronous — no network, no settlement.
 */
export function priceQuote(messages: ChatMessage[], cfg: AppConfig): PriceQuote {
  const c = classify(messages);
  const tier: Tier =
    c.difficulty >= cfg.routing.difficultyThreshold ? "strong" : "weak";
  const usd = quoteUsdForTier(tier, cfg);
  return { usd, atomicUsdc: toAtomicUsdc(usd), tier, difficulty: c.difficulty };
}
