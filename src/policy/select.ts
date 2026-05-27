import type {
  AppConfig,
  ChatCompletionRequest,
  RouteDecision,
  Tier,
} from "@/lib/types";
import { findProviderForModel, getProviders } from "@/providers/index";
import { classify } from "./classify";
import { approxTokens, scoreCandidates } from "./score";

/**
 * Stage 1 routing: difficulty-driven strong/weak cascade.
 *
 *  1. Explicit model → honored if an active provider supports it.
 *  2. classify() → difficulty, taskClass, expectedOutTokens.
 *  3. Cascade: difficulty ≥ threshold → strong tier, else weak tier.
 *  4. Among candidates in that tier, pick the lowest score (cheapest by default).
 *
 * The human-readable `reason` carries the class/difficulty/tier so the live spend
 * feed shows *why* each route was chosen.
 */
export function route(cfg: AppConfig, req: ChatCompletionRequest): RouteDecision {
  const messages = req.messages ?? [];

  // ── 1. Explicit model override ────────────────────────────────────────────────
  if (req.model && req.model !== "auto") {
    const provider = findProviderForModel(cfg, req.model);
    if (provider) {
      return {
        provider: provider.id,
        model: req.model,
        reason: `explicit model "${req.model}" → ${provider.displayName}`,
      };
    }
  }

  // ── 2. Classify ────────────────────────────────────────────────────────────────
  const classification = classify(messages);
  const inputTokens = approxTokens(messages.map((m) => m.content).join(" "));

  // ── 3. Cascade tier ──────────────────────────────────────────────────────────────
  const desiredTier: Tier =
    classification.difficulty >= cfg.routing.difficultyThreshold ? "strong" : "weak";

  // ── 4. Score + pick ──────────────────────────────────────────────────────────────
  const scored = scoreCandidates(cfg, classification, inputTokens);
  if (scored.length === 0) {
    const first = getProviders(cfg)[0];
    return {
      provider: first?.id ?? "venice",
      model: req.model && req.model !== "auto" ? req.model : "",
      reason: "fallback — no candidate models available",
    };
  }

  const inTier = scored.filter((c) => c.tier === desiredTier);
  const pick = (inTier.length > 0 ? inTier : scored)[0];

  return {
    provider: pick.provider,
    model: pick.model,
    reason:
      `${classification.taskClass} · difficulty ${classification.difficulty.toFixed(2)} → ` +
      `${pick.tier} tier · ${pick.provider}/${pick.model} (est $${pick.estCostUsd.toFixed(6)})`,
  };
}
