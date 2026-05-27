import type {
  AppConfig,
  ChatCompletionRequest,
  RouteDecision,
  Tier,
} from "@/lib/types";
import { findProviderForModel, getProviders } from "@/providers/index";
import { classify } from "./classify";
import { approxTokens, scoreCandidates } from "./score";
import { policyParams, resolvePolicyMode } from "./modes";

export interface RouteOpts {
  /** Per-request policy override (from the X-Billz-Policy header). */
  policyMode?: string | null;
}

/**
 * Routing: classify → policy mode → strong/weak cascade → best in tier.
 *
 *  1. Explicit model honored if a provider supports it.
 *  2. classify() → difficulty, taskClass, expectedOutTokens.
 *  3. Resolve the policy mode (frugal/balanced/premium/uncensored) → routing params.
 *  4. Cascade: difficulty ≥ mode threshold → strong tier, else weak.
 *  5. Pick the lowest-score candidate in the tier (score blends cost + learned
 *     quality per the mode's weights), honoring a mode tag preference if any.
 *
 * Always returns the taskClass + difficulty so the call can be labeled by feedback.
 */
export function route(
  cfg: AppConfig,
  req: ChatCompletionRequest,
  opts?: RouteOpts,
): RouteDecision {
  const messages = req.messages ?? [];
  const classification = classify(messages);
  const label = {
    taskClass: classification.taskClass,
    difficulty: classification.difficulty,
  };

  // 1. Explicit model override.
  if (req.model && req.model !== "auto") {
    const provider = findProviderForModel(cfg, req.model);
    if (provider) {
      return {
        provider: provider.id,
        model: req.model,
        reason: `explicit model "${req.model}" → ${provider.displayName}`,
        ...label,
      };
    }
  }

  // 2. Policy mode → routing params.
  const mode = resolvePolicyMode(opts?.policyMode);
  const params = policyParams(mode);
  const inputTokens = approxTokens(messages.map((m) => m.content).join(" "));
  const desiredTier: Tier =
    classification.difficulty >= params.difficultyThreshold ? "strong" : "weak";

  // 3. Score candidates with the mode's cost/quality weights.
  const effCfg: AppConfig = {
    ...cfg,
    routing: {
      ...cfg.routing,
      latencyWeight: params.latencyWeight,
      qualityWeight: params.qualityWeight,
    },
  };
  const scored = scoreCandidates(effCfg, classification, inputTokens);

  if (scored.length === 0) {
    const first = getProviders(cfg)[0];
    return {
      provider: first?.id ?? "venice",
      model: req.model && req.model !== "auto" ? req.model : "",
      reason: "fallback — no candidate models available",
      ...label,
    };
  }

  // 4. Pick within the cascade tier; honor a mode's tag preference if set.
  let pool = scored.filter((c) => c.tier === desiredTier);
  if (pool.length === 0) pool = scored;
  if (params.preferTags?.length) {
    const tagged = pool.filter((c) =>
      c.tags?.some((t) => params.preferTags!.includes(t)),
    );
    if (tagged.length > 0) pool = tagged;
  }
  const pick = pool[0];

  return {
    provider: pick.provider,
    model: pick.model,
    reason:
      `${classification.taskClass} · difficulty ${classification.difficulty.toFixed(2)} → ` +
      `${pick.tier} tier · ${pick.provider}/${pick.model} · ${mode} (est $${pick.estCostUsd.toFixed(6)})`,
    ...label,
  };
}
