import { describe, it, expect, beforeEach } from "vitest";
import { getCache, resetCache, createCache } from "./cache";
import { createMemoryStore } from "@/lib/store";
import type { AppConfig, ChatMessage, CompletionResult } from "@/lib/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal CompletionResult for store() calls. */
function makeResult(text = "Paris is the capital of France."): CompletionResult {
  return {
    provider: "mock",
    model: "mock-1",
    text,
    inputTokens: 10,
    outputTokens: 8,
    usdcCharged: 0,
    paymentMode: "mock",
    latencyMs: 5,
  };
}

function makeCfg(
  overrides: Partial<AppConfig["cache"]> = {},
): AppConfig {
  return {
    providerMode: "mock",
    sessionBudgetUsd: 1,
    maxPaymentPerCallUsd: 0.1,
    network: "base-sepolia",
    venice: { baseUrl: "http://localhost" },
    hyperbolic: { url: "http://localhost" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: {
      enabled: true,
      simThreshold: 0.85,
      ttlMs: 60_000,
      maxEntries: 100,
      ...overrides,
    },
  } as AppConfig;
}

const QUESTION_MSGS: ChatMessage[] = [
  { role: "user", content: "What is the capital of France?" },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SemanticCache", () => {
  beforeEach(() => {
    resetCache();
  });

  it("exact repeat → exact hit with similarity 1", async () => {
    const cache = getCache(makeCfg());
    await cache.store(QUESTION_MSGS, makeResult());

    const result = await cache.lookup(QUESTION_MSGS);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.kind).toBe("exact");
      expect(result.similarity).toBe(1);
      expect(result.result.text).toBe("Paris is the capital of France.");
    }
  });

  it("near-duplicate phrasing → semantic hit (kind 'semantic', similarity ≥ threshold)", async () => {
    const cfg = makeCfg({ simThreshold: 0.85 });
    const cache = getCache(cfg);
    await cache.store(QUESTION_MSGS, makeResult());

    // Slightly rephrased — same intent, one word swapped
    const fuzzyMsgs: ChatMessage[] = [
      { role: "user", content: "What is the capital city of France?" },
    ];
    const result = await cache.lookup(fuzzyMsgs);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.kind).toBe("semantic");
      expect(result.similarity).toBeGreaterThanOrEqual(0.85);
    }
  });

  it("unrelated prompt → miss", async () => {
    const cache = getCache(makeCfg());
    await cache.store(QUESTION_MSGS, makeResult());

    const unrelated: ChatMessage[] = [
      { role: "user", content: "Write a quicksort implementation in Rust." },
    ];
    const result = await cache.lookup(unrelated);
    expect(result.hit).toBe(false);
  });

  it("TTL expiry → miss after TTL elapsed", async () => {
    // 1s TTL: wide enough that the "before expiry" check is robust even when the
    // full parallel suite is busy, while still expiring quickly.
    const cache = getCache(makeCfg({ ttlMs: 1000 }));
    await cache.store(QUESTION_MSGS, makeResult());

    // Confirm it's a hit before expiry
    const before = await cache.lookup(QUESTION_MSGS);
    expect(before.hit).toBe(true);

    // Wait for TTL to lapse
    await new Promise((r) => setTimeout(r, 1200));

    const after = await cache.lookup(QUESTION_MSGS);
    expect(after.hit).toBe(false);
  });

  it("eviction beyond maxEntries drops the oldest entry", async () => {
    const cache = getCache(makeCfg({ maxEntries: 2 }));

    const msgs1: ChatMessage[] = [{ role: "user", content: "Question alpha one" }];
    const msgs2: ChatMessage[] = [{ role: "user", content: "Question beta two" }];
    const msgs3: ChatMessage[] = [{ role: "user", content: "Question gamma three" }];

    await cache.store(msgs1, makeResult("answer 1"));
    await cache.store(msgs2, makeResult("answer 2"));
    // Storing a third entry exceeds maxEntries=2 → msgs1 (oldest) evicted
    await cache.store(msgs3, makeResult("answer 3"));

    const r1 = await cache.lookup(msgs1);
    expect(r1.hit).toBe(false); // evicted

    const r2 = await cache.lookup(msgs2);
    expect(r2.hit).toBe(true);

    const r3 = await cache.lookup(msgs3);
    expect(r3.hit).toBe(true);
  });

  it("stats() correctly counts hits and misses", async () => {
    const cache = getCache(makeCfg());
    await cache.store(QUESTION_MSGS, makeResult());

    await cache.lookup(QUESTION_MSGS); // hit
    await cache.lookup(QUESTION_MSGS); // hit

    const unrelated: ChatMessage[] = [
      { role: "user", content: "Tell me about black holes." },
    ];
    await cache.lookup(unrelated); // miss

    const s = cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.entries).toBe(1);
  });

  it("getCache returns the same singleton on repeated calls", () => {
    const cfg = makeCfg();
    const c1 = getCache(cfg);
    const c2 = getCache(cfg);
    expect(c1).toBe(c2);
  });

  it("resetCache clears the singleton so next getCache builds fresh", async () => {
    const cfg = makeCfg();
    const c1 = getCache(cfg);
    await c1.store(QUESTION_MSGS, makeResult());

    resetCache();

    const c2 = getCache(cfg);
    expect(c2).not.toBe(c1);
    const result = await c2.lookup(QUESTION_MSGS);
    expect(result.hit).toBe(false);
  });

  it("shared store mirrors the exact layer across cache instances", async () => {
    // One store stands in for Redis shared between two serverless instances.
    const shared = createMemoryStore();
    const cacheA = createCache(makeCfg().cache, shared);
    const cacheB = createCache(makeCfg().cache, shared);

    // Instance A stores a result; its in-memory map is separate from B's.
    await cacheA.store(QUESTION_MSGS, makeResult());

    // Instance B has an empty local map but finds the entry via the shared store.
    const hit = await cacheB.lookup(QUESTION_MSGS);
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.kind).toBe("exact");
      expect(hit.similarity).toBe(1);
      expect(hit.result.text).toBe("Paris is the capital of France.");
    }
  });

  it("without a shared store, a fresh instance does NOT see another's entry", async () => {
    // No store passed → pure in-memory, so instances are isolated.
    const cacheA = createCache(makeCfg().cache);
    const cacheB = createCache(makeCfg().cache);
    await cacheA.store(QUESTION_MSGS, makeResult());
    const miss = await cacheB.lookup(QUESTION_MSGS);
    expect(miss.hit).toBe(false);
  });

  it("multi-turn conversation is canonicalized and cached correctly", async () => {
    const cache = getCache(makeCfg());
    const multiTurn: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: "Paris." },
      { role: "user", content: "And what about Germany?" },
    ];
    await cache.store(multiTurn, makeResult("Berlin is the capital of Germany."));

    const result = await cache.lookup(multiTurn);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.kind).toBe("exact");
      expect(result.result.text).toBe("Berlin is the capital of Germany.");
    }
  });

  // ── Model scoping (multi-terminal compare-models UX) ──────────────────────────

  it("different model scopes do not share a cached answer", async () => {
    const cache = getCache(makeCfg());
    await cache.store(QUESTION_MSGS, makeResult("answer from model A"), "model-a");

    // Same prompt, a different pinned model → must miss (not serve A's answer).
    const miss = await cache.lookup(QUESTION_MSGS, "model-b");
    expect(miss.hit).toBe(false);

    // The shared (auto) namespace is also separate from a pinned model.
    const autoMiss = await cache.lookup(QUESTION_MSGS, "");
    expect(autoMiss.hit).toBe(false);
  });

  it("same model scope still hits (per-model cost saving preserved)", async () => {
    const cache = getCache(makeCfg());
    await cache.store(QUESTION_MSGS, makeResult("answer from model A"), "model-a");

    const hit = await cache.lookup(QUESTION_MSGS, "model-a");
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.result.text).toBe("answer from model A");
    }
  });

  it("semantic layer also respects scope (near-duplicate, wrong model → miss)", async () => {
    const cache = getCache(makeCfg({ simThreshold: 0.85 }));
    await cache.store(QUESTION_MSGS, makeResult("answer from model A"), "model-a");

    const nearDup: ChatMessage[] = [
      { role: "user", content: "What's the capital of France?" },
    ];
    // Would be a semantic hit in the same scope, but a different model must miss.
    const miss = await cache.lookup(nearDup, "model-b");
    expect(miss.hit).toBe(false);
  });
});
