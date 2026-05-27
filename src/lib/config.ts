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

/**
 * Read configuration from the environment.
 *
 * Implemented as a function (not a module-level const) so values are read at
 * request time rather than baked in at build time — Next.js 16 no longer bundles
 * runtime config, and route handlers are dynamic, so `process.env` is live here.
 */
export function getConfig(): AppConfig {
  const mode: ProviderMode =
    process.env.BILLZ_PROVIDER_MODE === "live" ? "live" : "mock";
  const pk = process.env.WALLET_PRIVATE_KEY;
  return {
    providerMode: mode,
    sessionBudgetUsd: num(process.env.BILLZ_SESSION_BUDGET_USD, 5),
    userDailyBudgetUsd: num(process.env.BILLZ_USER_DAILY_BUDGET_USD, 0),
    welcomeCreditUsd: num(process.env.BILLZ_WELCOME_CREDIT_USD, 1),
    maxPaymentPerCallUsd: num(process.env.BILLZ_MAX_PAYMENT_PER_CALL_USD, 0.1),
    network: process.env.BILLZ_NETWORK || "base-sepolia",
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
    routing: {
      difficultyThreshold: num(process.env.BILLZ_DIFFICULTY_THRESHOLD, 0.5),
      latencyWeight: num(process.env.BILLZ_LATENCY_WEIGHT, 0),
      qualityWeight: num(process.env.BILLZ_QUALITY_WEIGHT, 0),
    },
    cache: {
      enabled: bool(process.env.BILLZ_CACHE_ENABLED, true),
      simThreshold: num(process.env.BILLZ_CACHE_SIM_THRESHOLD, 0.83),
      ttlMs: num(process.env.BILLZ_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
      maxEntries: num(process.env.BILLZ_CACHE_MAX_ENTRIES, 500),
      embedder: process.env.BILLZ_EMBEDDER === "minilm" ? "minilm" : "local",
    },
  };
}
