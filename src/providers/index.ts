import type { AppConfig, ModelInfo, ProviderAdapter, ProviderId } from "@/lib/types";
import { createMockAdapter } from "./mock";
import { createVeniceAdapter } from "./venice";
import { createHyperbolicAdapter } from "./hyperbolic";
import { createSurplusAdapter } from "./surplus";
import { createAnthropicAdapter } from "./anthropic";
import { createOpenRouterAdapter } from "./openrouter";

/**
 * Build the active provider set for the current config.
 * - mock mode → just the offline mock provider.
 * - live mode → Hyperbolic + Surplus (pure x402; the funded wallet pays), plus
 *   key-gated credit-balance providers:
 *     · Venice     when VENICE_API_KEY is set
 *     · Anthropic  when ANTHROPIC_API_KEY is set
 *     · OpenRouter when OPENROUTER_API_KEY is set (OpenAI-compatible; a second
 *                  route to Claude for accounts that can't fund Anthropic direct)
 *   Without its key, every request to a credit-balance provider would just 402 /
 *   401, so including it would only add a guaranteed-fail hop to routing and
 *   failover and surface dead models in the list. Failover across the active set
 *   is handled by the policy layer.
 */
export function getProviders(cfg: AppConfig): ProviderAdapter[] {
  if (cfg.providerMode === "mock") return [createMockAdapter(cfg)];
  const providers: ProviderAdapter[] = [
    createHyperbolicAdapter(cfg),
    createSurplusAdapter(cfg),
  ];
  // Credit-balance providers are reliable only with their API key; gate each
  // in when configured (unshifted so they lead routing/failover order).
  if (process.env.VENICE_API_KEY) providers.unshift(createVeniceAdapter(cfg));
  if (process.env.ANTHROPIC_API_KEY) providers.unshift(createAnthropicAdapter(cfg));
  if (process.env.OPENROUTER_API_KEY) providers.unshift(createOpenRouterAdapter(cfg));
  return providers;
}

export function getProvider(
  cfg: AppConfig,
  id: ProviderId,
): ProviderAdapter | undefined {
  return getProviders(cfg).find((p) => p.id === id);
}

/** First active provider that can serve the given model id. */
export function findProviderForModel(
  cfg: AppConfig,
  model: string,
): ProviderAdapter | undefined {
  return getProviders(cfg).find((p) => p.supports(model));
}

/** All models across active providers, tagged with their provider id. */
export function listModels(
  cfg: AppConfig,
): Array<ModelInfo & { provider: ProviderId }> {
  return getProviders(cfg).flatMap((p) =>
    p.models().map((m) => ({ ...m, provider: p.id })),
  );
}
