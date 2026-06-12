import type { AppConfig } from "@/lib/types";
import { resolvePricing } from "@/lib/config";

/**
 * Cost-plus margin (Phase A).
 *
 * Both paid lanes price off realized/estimated provider cost rather than a flat
 * per-tier rate, so a long Opus/Fable turn can no longer cost BEAMR more than it
 * charges. The credit-balance lane applies this to the *known* post-call cost
 * (exact cost-plus); the x402 lane applies it to the *estimated* pre-call cost
 * (so the margin must also absorb estimation error — see `quote.ts`).
 *
 * The single knob is `pricing.marginMultiplier` (default 1.3 → a 30% margin).
 */
export function withMargin(costUsd: number, cfg: AppConfig): number {
  return costUsd * resolvePricing(cfg).marginMultiplier;
}
