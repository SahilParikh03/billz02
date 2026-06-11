import { describe, it, expect } from "vitest";
import { withMargin } from "./margin";
import type { AppConfig } from "@/lib/types";

function cfg(marginMultiplier?: number): AppConfig {
  return {
    providerMode: "live",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base-sepolia",
    facilitatorUrl: "https://x402.org/facilitator",
    venice: { baseUrl: "https://api.venice.ai/api/v1" },
    hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
    ...(marginMultiplier != null ? { pricing: { marginMultiplier } } : {}),
  } as AppConfig;
}

describe("withMargin", () => {
  it("applies the configured margin multiplier", () => {
    expect(withMargin(0.01, cfg(1.5))).toBeCloseTo(0.015, 10);
    expect(withMargin(0.002, cfg(1.3))).toBeCloseTo(0.0026, 10);
  });

  it("defaults to a 1.3× margin when pricing is omitted (fixtures)", () => {
    // No `pricing` block → resolvePricing falls back to the 1.3 default.
    expect(withMargin(0.01, cfg())).toBeCloseTo(0.013, 10);
  });

  it("is a pure scalar: margin of zero cost is zero (flat-price fallback)", () => {
    expect(withMargin(0, cfg(1.3))).toBe(0);
  });
});
