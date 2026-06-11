import { describe, it, expect } from "vitest";
import { priceQuote, quoteUsdForTier, toAtomicUsdc } from "./quote";
import { withMargin } from "./margin";
import { estimateCostUsd } from "@/policy/score";
import type { AppConfig, ChatMessage } from "@/lib/types";

function cfg(over: Partial<AppConfig["sell"]> = {}, rest: Partial<AppConfig> = {}): AppConfig {
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
    sell: {
      enabled: true,
      payTo: "0x" + "1".repeat(40),
      priceWeakUsd: 0.002,
      priceStrongUsd: 0.01,
      maxTimeoutSeconds: 120,
      ...over,
    },
    ...rest,
  } as AppConfig;
}

// Mock-mode config: the mock provider carries real per-token prices (mock-strong
// is pricey: 3.75/18.75 per 1M), so a hard prompt's cost-plus quote lands well
// above the flat strong floor — exercising the genuine cost-plus path.
function mockCfg(over: Partial<AppConfig["sell"]> = {}, rest: Partial<AppConfig> = {}): AppConfig {
  return cfg(over, { providerMode: "mock", ...rest });
}

const msg = (content: string): ChatMessage[] => [{ role: "user", content }];

const HARD =
  "design a rate limiter: walk through the algorithm, analyze the " +
  "tradeoffs, and compare token-bucket vs sliding-window in detail";

describe("toAtomicUsdc", () => {
  it("converts USD to 6-decimal atomic units", () => {
    expect(toAtomicUsdc(0.002)).toBe(BigInt(2000));
    expect(toAtomicUsdc(0.01)).toBe(BigInt(10000));
    expect(toAtomicUsdc(1)).toBe(BigInt(1000000));
  });

  it("rounds to the nearest atomic unit (no float dust)", () => {
    // 0.0000001 USD → 0.1 atomic → rounds to 0.
    expect(toAtomicUsdc(0.0000001)).toBe(BigInt(0));
    expect(toAtomicUsdc(0.0000005)).toBe(BigInt(1));
  });
});

describe("quoteUsdForTier", () => {
  it("maps tier → configured flat price", () => {
    expect(quoteUsdForTier("weak", cfg())).toBe(0.002);
    expect(quoteUsdForTier("strong", cfg())).toBe(0.01);
  });

  it("honors overridden prices", () => {
    const c = cfg({ priceWeakUsd: 0.005, priceStrongUsd: 0.05 });
    expect(quoteUsdForTier("weak", c)).toBe(0.005);
    expect(quoteUsdForTier("strong", c)).toBe(0.05);
  });
});

describe("priceQuote", () => {
  it("prices a trivial prompt at the weak-tier flat rate", () => {
    const q = priceQuote(msg("hi"), cfg());
    expect(q.tier).toBe("weak");
    expect(q.usd).toBe(0.002);
    expect(q.atomicUsdc).toBe(BigInt(2000));
    expect(q.difficulty).toBeLessThan(0.5);
  });

  it("prices a hard prompt at the strong-tier flat rate", () => {
    const q = priceQuote(
      msg(
        "design a rate limiter: walk through the algorithm, analyze the " +
          "tradeoffs, and compare token-bucket vs sliding-window in detail",
      ),
      cfg(),
    );
    expect(q.tier).toBe("strong");
    expect(q.usd).toBe(0.01);
    expect(q.atomicUsdc).toBe(BigInt(10000));
    expect(q.difficulty).toBeGreaterThanOrEqual(0.5);
  });

  it("tier follows the routing difficultyThreshold", () => {
    // Threshold 0 → everything is strong; threshold 1 → everything is weak.
    expect(priceQuote(msg("hi"), cfg()).tier).toBe("weak");
    const allStrong = { ...cfg(), routing: { difficultyThreshold: 0, latencyWeight: 0, qualityWeight: 0 } };
    expect(priceQuote(msg("hi"), allStrong).tier).toBe("strong");
  });
});

describe("priceQuote — cost-plus", () => {
  it("holds at the flat-tier floor when cost-plus is below it (cheap call)", () => {
    // "hi" costs a fraction of a cent to serve, so its cost-plus is far below the
    // flat weak rate → the quote clamps up to the floor.
    const q = priceQuote(msg("hi"), mockCfg());
    expect(q.tier).toBe("weak");
    expect(q.usd).toBe(0.002);
    expect(q.atomicUsdc).toBe(BigInt(2000));
  });

  it("charges true cost-plus when it exceeds the flat-tier floor (expensive call)", () => {
    const c = mockCfg();
    const q = priceQuote(msg(HARD), c);
    const expected = withMargin(estimateCostUsd(msg(HARD), c), c);
    expect(q.tier).toBe("strong");
    // Cost-plus, not the flat $0.01 strong rate — margin is protected.
    expect(q.usd).toBeGreaterThan(quoteUsdForTier("strong", c));
    expect(q.usd).toBeCloseTo(expected, 10);
  });

  it("clamps the cost-plus quote to maxPaymentPerCallUsd (pre-paid overshoot bound)", () => {
    const c = mockCfg({}, { maxPaymentPerCallUsd: 0.02 });
    const q = priceQuote(msg(HARD), c);
    // Uncapped cost-plus exceeds $0.02 here, so the quote pins to the cap.
    expect(q.usd).toBe(0.02);
    expect(q.atomicUsdc).toBe(BigInt(20000));
  });

  it("scales with the margin multiplier", () => {
    const lo = priceQuote(msg(HARD), mockCfg({}, { pricing: { marginMultiplier: 1.1 } }));
    const hi = priceQuote(msg(HARD), mockCfg({}, { pricing: { marginMultiplier: 2.0 } }));
    expect(hi.usd).toBeGreaterThan(lo.usd);
  });
});
