import type { AppConfig, ModelInfo, ProviderAdapter, ProviderId } from "@/lib/types";
import { createMockAdapter } from "./mock";
import { createVeniceAdapter } from "./venice";
import { createHyperbolicAdapter } from "./hyperbolic";
import { createSurplusAdapter } from "./surplus";

/**
 * Build the active provider set for the current config.
 * - mock mode → just the offline mock provider.
 * - live mode → Hyperbolic + Surplus (pure x402; the funded wallet pays), plus
 *   Venice ONLY when VENICE_API_KEY is set. Without a key every Venice request
 *   returns 402, so including it just adds a guaranteed-fail hop to routing and
 *   failover. Failover across the active set is handled by the policy layer.
 */
export function getProviders(cfg: AppConfig): ProviderAdapter[] {
  if (cfg.providerMode === "mock") return [createMockAdapter(cfg)];
  const providers: ProviderAdapter[] = [
    createHyperbolicAdapter(cfg),
    createSurplusAdapter(cfg),
  ];
  // Venice is reliable only with a Bearer key; gate it in when configured.
  if (process.env.VENICE_API_KEY) providers.unshift(createVeniceAdapter(cfg));
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
