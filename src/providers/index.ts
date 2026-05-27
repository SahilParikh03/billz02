import type { AppConfig, ModelInfo, ProviderAdapter, ProviderId } from "@/lib/types";
import { createMockAdapter } from "./mock";
import { createVeniceAdapter } from "./venice";
import { createHyperbolicAdapter } from "./hyperbolic";
import { createSurplusAdapter } from "./surplus";

/**
 * Build the active provider set for the current config.
 * - mock mode → just the offline mock provider.
 * - live mode → Venice + Hyperbolic + Surplus Intelligence (Stage 2 triple).
 *   Surplus is Base-mainnet only (flat $0.003306/call); failover across providers
 *   is handled by the router policy layer, not here.
 */
export function getProviders(cfg: AppConfig): ProviderAdapter[] {
  if (cfg.providerMode === "mock") return [createMockAdapter(cfg)];
  return [createVeniceAdapter(cfg), createHyperbolicAdapter(cfg), createSurplusAdapter(cfg)];
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
