import { describe, it, expect, beforeAll } from "vitest";
import type { AppConfig, SpendEvent } from "@/lib/types";
import { executeChat } from "@/pipeline/execute";
import { createMockAdapter } from "@/providers/mock";
import { subscribeSpend } from "@/lib/events";
import { resetStore } from "@/lib/store";
import { resetCache } from "@/pipeline/cache";

/**
 * A/B harness: BEAMR router (classify → cascade → cache) vs an always-strong
 * baseline, in mock mode. Reports cost-per-resolved-query and asserts a real
 * cost reduction. Mock costs are deterministic, so this is a stable guardrail
 * for the Stage 1 "≥40% cheaper at parity" thesis (here we assert a conservative
 * floor; quality parity needs a live judge, which is Stage 1's A/B-with-judge).
 */

const cfg: AppConfig = {
  providerMode: "mock",
  sessionBudgetUsd: 1000, // large, so the harness never hits the cap
  maxPaymentPerCallUsd: 0.1,
  network: "base-sepolia",
  facilitatorUrl: "https://x402.org/facilitator",
  venice: { baseUrl: "https://api.venice.ai/api/v1" },
  hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
  cache: { enabled: true, simThreshold: 0.83, ttlMs: 86_400_000, maxEntries: 500 },
};

// Originals first, then exact + near-duplicates to exercise the cache.
const PROMPTS = [
  "hi",
  "hello there",
  "thanks!",
  "good morning",
  "what is the capital of France",
  "who wrote Hamlet",
  "what is 2 plus 2",
  "write a python function to reverse a linked list",
  "fix the TypeError in my async handler code",
  "implement a debounce utility in typescript",
  "explain step by step why the sky is blue",
  "compare TCP and UDP and their tradeoffs in detail",
  "prove that the square root of 2 is irrational",
  "write a short poem about the ocean",
  "brainstorm five names for a coffee app",
  // duplicates / near-duplicates → should hit the cache:
  "hi",
  "what is the capital of France",
  "hello there!",
  "thanks!",
];

interface Report {
  baselineCost: number;
  routerCost: number;
  reductionPct: number;
  cacheHits: number;
  routeDist: Record<string, number>;
  events: SpendEvent[];
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    void _;
  }
}

const report: Report = {
  baselineCost: 0,
  routerCost: 0,
  reductionPct: 0,
  cacheHits: 0,
  routeDist: {},
  events: [],
};

beforeAll(async () => {
  // ── Baseline: always the strong model, no cache ──
  const mock = createMockAdapter(cfg);
  for (const content of PROMPTS) {
    for await (const ev of mock.stream({ model: "mock-strong", messages: [{ role: "user", content }] })) {
      if (ev.type === "done") report.baselineCost += ev.result.usdcCharged;
    }
  }

  // ── Router: classify → cascade → cache ──
  resetCache();
  resetStore();
  const events: SpendEvent[] = [];
  const unsub = subscribeSpend((e) => events.push(e));
  for (const content of PROMPTS) {
    await drain(
      executeChat(cfg, { model: "auto", messages: [{ role: "user", content }] }, { sessionId: "ab", traceId: "t" }),
    );
  }
  unsub();

  report.events = events;
  report.routerCost = events.reduce((s, e) => s + e.usdcCharged, 0);
  report.cacheHits = events.filter((e) => e.cacheHit).length;
  for (const e of events) {
    const key = e.cacheHit ? "cache" : `${e.provider}/${e.model}`;
    report.routeDist[key] = (report.routeDist[key] ?? 0) + 1;
  }
  report.reductionPct = (1 - report.routerCost / report.baselineCost) * 100;

  // eslint-disable-next-line no-console
  console.log(
    [
      "\n──────── BEAMR A/B (mock mode) ────────",
      `prompts:            ${PROMPTS.length}`,
      `baseline (strong):  $${report.baselineCost.toFixed(6)}`,
      `router:             $${report.routerCost.toFixed(6)}`,
      `cost reduction:     ${report.reductionPct.toFixed(1)}%`,
      `cache hits:         ${report.cacheHits}/${PROMPTS.length} (${((report.cacheHits / PROMPTS.length) * 100).toFixed(0)}%)`,
      `route distribution: ${JSON.stringify(report.routeDist)}`,
      "───────────────────────────────────────\n",
    ].join("\n"),
  );
}, 120_000);

describe("router A/B vs always-strong baseline (mock)", () => {
  it("emits one spend event per request", () => {
    expect(report.events.length).toBe(PROMPTS.length);
  });

  it("routes cheap/repeat traffic away from the strong model", () => {
    expect(report.routerCost).toBeLessThan(report.baselineCost);
  });

  it("achieves a substantial cost reduction", () => {
    expect(report.reductionPct).toBeGreaterThan(20);
  });

  it("serves the duplicate/near-duplicate prompts from cache", () => {
    // 2 exact dups + 1 near-dup + 1 exact dup = 4 cache hits expected
    expect(report.cacheHits).toBeGreaterThanOrEqual(3);
  });
});
