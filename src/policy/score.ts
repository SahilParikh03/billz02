import type {
  AppConfig,
  ChatMessage,
  Classification,
  ModelInfo,
  QueryClass,
  ScoredCandidate,
  Tier,
} from "@/lib/types";
import { getProviders } from "@/providers/index";
import { learnedQuality } from "@/lib/quality";
import { classify } from "./classify";

/**
 * Candidate scoring for the strong/weak cascade.
 *
 * Each active model becomes a candidate scored by:
 *   score = estCostUsd + λ·estLatencyMs + μ·(1 − qualityPrior)
 * Lower is better. With the default weights (λ = μ = 0) this reduces to "cheapest
 * model", and the cascade (which tier to pick from) is driven by difficulty in
 * select.ts. The weights exist so cost/latency/quality can be traded off later.
 */

// Price priors (USD per 1M tokens) for providers that price dynamically (Hyperbolic).
const FALLBACK_INPUT_PER_M = 0.4;
const FALLBACK_OUTPUT_PER_M = 1.5;

// Coarse latency priors (ms) by tier — only used when latencyWeight > 0.
const LATENCY_MS: Record<Tier, number> = { weak: 600, strong: 1600 };

/** Rough token estimate (~1.3 tokens per whitespace word). */
export function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

/** Classify a model into the cheap ("weak") or capable ("strong") tier. */
export function modelTier(m: ModelInfo): Tier {
  if (m.tags?.includes("reasoning")) return "strong";
  if (m.tags?.includes("fast") || m.tags?.includes("cheap")) return "weak";
  if (m.outputPricePerM != null && m.outputPricePerM >= 3) return "strong";
  return "weak";
}

/** 0..1 prior that a model is a good fit for the task class. */
export function qualityPrior(m: ModelInfo, taskClass: QueryClass): number {
  const tags = m.tags ?? [];
  const matches: Record<QueryClass, boolean> = {
    code: tags.includes("code"),
    reasoning: tags.includes("reasoning"),
    creative: tags.includes("creative") || tags.includes("uncensored"),
    chat: tags.includes("chat"),
  };
  let q = 0.5;
  if (matches[taskClass]) q += 0.3;
  if ((taskClass === "reasoning" || taskClass === "code") && modelTier(m) === "strong") {
    q += 0.1;
  }
  return Math.max(0, Math.min(1, q));
}

/** Estimated USD cost for a model given input + expected-output token counts. */
export function estCostUsd(m: ModelInfo, inputTokens: number, outTokens: number): number {
  const inP = m.inputPricePerM ?? FALLBACK_INPUT_PER_M;
  const outP = m.outputPricePerM ?? FALLBACK_OUTPUT_PER_M;
  return (inputTokens / 1e6) * inP + (outTokens / 1e6) * outP;
}

/** Score every active candidate, returned ascending by score (best first). */
export function scoreCandidates(
  cfg: AppConfig,
  classification: Classification,
  inputTokens: number,
): ScoredCandidate[] {
  const { latencyWeight, qualityWeight } = cfg.routing;
  const out: ScoredCandidate[] = [];

  for (const p of getProviders(cfg)) {
    for (const m of p.models()) {
      const tier = modelTier(m);
      const estCost = estCostUsd(m, inputTokens, classification.expectedOutTokens);
      const staticQ = qualityPrior(m, classification.taskClass);
      // Blend in the learned (feedback-derived) win-rate once any votes exist.
      const learned = learnedQuality(classification.taskClass, p.id, m.id);
      const q = learned != null ? 0.5 * staticQ + 0.5 * learned : staticQ;
      const score =
        estCost + latencyWeight * LATENCY_MS[tier] + qualityWeight * (1 - q);
      out.push({
        provider: p.id,
        model: m.id,
        score,
        estCostUsd: estCost,
        qualityPrior: q,
        tier,
        tags: m.tags,
      });
    }
  }

  out.sort((a, b) => a.score - b.score);
  return out;
}

/**
 * Estimate the USD provider cost of serving a request — the cost-plus pricing
 * input shared by the credit and x402 lanes.
 *
 * classify → pick the cascade tier (same `difficultyThreshold` routing uses) →
 * take the representative in-tier model: the cheapest candidate in that tier,
 * i.e. the one the (frugal) router would actually pick. Reuses {@link classify},
 * {@link approxTokens}, and {@link scoreCandidates} so the estimate tracks the
 * real routing math rather than duplicating it.
 *
 * Pure and synchronous (no network). Returns 0 when no candidate models are
 * available, signaling callers (e.g. `priceQuote`) to fall back to a flat price.
 */
export function estimateCostUsd(messages: ChatMessage[], cfg: AppConfig): number {
  const classification = classify(messages);
  const inputTokens = approxTokens(messages.map((m) => m.content).join(" "));
  const tier: Tier =
    classification.difficulty >= cfg.routing.difficultyThreshold ? "strong" : "weak";
  const scored = scoreCandidates(cfg, classification, inputTokens);
  if (scored.length === 0) return 0;
  const inTier = scored.filter((c) => c.tier === tier);
  // Cheapest in the tier (scored ascending); fall back to the cheapest overall
  // if the tier is empty — mirrors the cascade pool fallback in select.ts.
  return (inTier.length > 0 ? inTier : scored)[0].estCostUsd;
}
