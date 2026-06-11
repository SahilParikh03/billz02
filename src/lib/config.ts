import type { Hex } from "viem";
import type { AppConfig, ProviderMode } from "./types";

function num(v: string | undefined, fallback: number): number {
  const n = v != null && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v == null || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

/** Seller-side paywall defaults — single source for getConfig + resolveSell. */
const SELL_DEFAULTS: NonNullable<AppConfig["sell"]> = {
  enabled: false,
  payTo: undefined,
  priceWeakUsd: 0.002,
  priceStrongUsd: 0.01,
  maxTimeoutSeconds: 120,
};

/**
 * Resolve the seller config, falling back to defaults when a caller passes an
 * AppConfig that omits `sell` (e.g. test fixtures). `getConfig()` always sets
 * it, so in the live request path this is a passthrough.
 */
export function resolveSell(cfg: AppConfig): NonNullable<AppConfig["sell"]> {
  return cfg.sell ?? SELL_DEFAULTS;
}

/**
 * Read configuration from the environment.
 *
 * Implemented as a function (not a module-level const) so values are read at
 * request time rather than baked in at build time — Next.js 16 no longer bundles
 * runtime config, and route handlers are dynamic, so `process.env` is live here.
 */
export function getConfig(): AppConfig {
  const mode: ProviderMode =
    process.env.BEAMR_PROVIDER_MODE === "live" ? "live" : "mock";
  const pk = process.env.WALLET_PRIVATE_KEY;
  return {
    providerMode: mode,
    sessionBudgetUsd: num(process.env.BEAMR_SESSION_BUDGET_USD, 5),
    userDailyBudgetUsd: num(process.env.BEAMR_USER_DAILY_BUDGET_USD, 0),
    welcomeCreditUsd: num(process.env.BEAMR_WELCOME_CREDIT_USD, 1),
    maxPaymentPerCallUsd: num(process.env.BEAMR_MAX_PAYMENT_PER_CALL_USD, 0.1),
    network: process.env.BEAMR_NETWORK || "base-sepolia",
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
    walletPrivateKey:
      pk && pk.startsWith("0x") ? (pk as Hex) : undefined,
    venice: {
      baseUrl: process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1",
    },
    hyperbolic: {
      url:
        process.env.HYPERBOLIC_X402_URL ||
        "https://hyperbolic-x402.vercel.app/v1/chat/completions",
    },
    anthropic: {
      baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    },
    openrouter: {
      baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
    },
    routing: {
      difficultyThreshold: num(process.env.BEAMR_DIFFICULTY_THRESHOLD, 0.5),
      latencyWeight: num(process.env.BEAMR_LATENCY_WEIGHT, 0),
      qualityWeight: num(process.env.BEAMR_QUALITY_WEIGHT, 0),
    },
    cache: {
      enabled: bool(process.env.BEAMR_CACHE_ENABLED, true),
      simThreshold: num(process.env.BEAMR_CACHE_SIM_THRESHOLD, 0.83),
      ttlMs: num(process.env.BEAMR_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
      maxEntries: num(process.env.BEAMR_CACHE_MAX_ENTRIES, 500),
      embedder: process.env.BEAMR_EMBEDDER === "minilm" ? "minilm" : "local",
    },
    sell: {
      ...SELL_DEFAULTS,
      enabled: bool(process.env.BEAMR_SELL_ENABLED, SELL_DEFAULTS.enabled),
      payTo: process.env.BEAMR_SELL_PAY_TO || undefined,
      priceWeakUsd: num(process.env.BEAMR_SELL_PRICE_WEAK_USD, SELL_DEFAULTS.priceWeakUsd),
      priceStrongUsd: num(process.env.BEAMR_SELL_PRICE_STRONG_USD, SELL_DEFAULTS.priceStrongUsd),
      maxTimeoutSeconds: num(
        process.env.BEAMR_SELL_MAX_TIMEOUT_SECONDS,
        SELL_DEFAULTS.maxTimeoutSeconds,
      ),
    },
  };
}
