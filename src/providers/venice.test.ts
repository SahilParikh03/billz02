import { describe, it, expect, vi } from "vitest";
import { createVeniceAdapter } from "./venice";
import type { AppConfig, CompletionResult } from "@/lib/types";
import type { VenicelDeps } from "./venice";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_CFG: AppConfig = {
  providerMode: "live",
  sessionBudgetUsd: 5,
  maxPaymentPerCallUsd: 0.10,
  network: "base-sepolia",
  facilitatorUrl: "https://x402.org/facilitator",
  walletPrivateKey: undefined,
  venice: { baseUrl: "https://api.venice.ai/api/v1" },
  hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
  cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
};

/**
 * Build a fake fetch that returns an OpenAI-style SSE stream.
 *
 * @param deltas  - Array of content strings to emit as `choices[0].delta.content`.
 * @param usage   - Optional usage block included in the final data chunk.
 * @param extraHeaders - Additional headers on the mock Response.
 */
function makeSseFetch(
  deltas: string[],
  usage?: { prompt_tokens: number; completion_tokens: number },
  extraHeaders: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const lines: string[] = deltas.map(
      (content, i) =>
        `data: ${JSON.stringify({
          choices: [{ delta: { content }, finish_reason: null }],
          // Include usage in the last delta chunk
          ...(i === deltas.length - 1 && usage ? { usage } : {}),
        })}\n\n`,
    );
    lines.push("data: [DONE]\n\n");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        ...extraHeaders,
      },
    });
  }) as unknown as typeof fetch;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("venice adapter", () => {
  it("streams deltas then a terminal done event", async () => {
    const fakeFetch = makeSseFetch(["Hello", " world", "!"]);
    const deps: VenicelDeps = { fetchImpl: fakeFetch };
    const adapter = createVeniceAdapter(MOCK_CFG, deps);

    const deltas: string[] = [];
    let done: CompletionResult | undefined;

    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      if (ev.type === "delta") deltas.push(ev.content);
      if (ev.type === "done") done = ev.result;
      if (ev.type === "error") throw new Error(`Unexpected error: ${ev.error}`);
    }

    // Deltas arrive in order
    expect(deltas).toEqual(["Hello", " world", "!"]);
    // A terminal done arrives
    expect(done).toBeDefined();
  });

  it("done event has correct provider and paymentMode", async () => {
    const adapter = createVeniceAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["answer"]),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "test" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.provider).toBe("venice");
    expect(done!.paymentMode).toBe("credit-balance");
  });

  it("usdcCharged is non-negative and computed from price priors", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 20 };
    const adapter = createVeniceAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["reply"], usage),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.usdcCharged).toBeGreaterThanOrEqual(0);
    // 10 input tokens @ $0.70/1M + 20 output tokens @ $2.80/1M = 0.0000630 USD ≈ 0.000063
    const expected = (10 / 1e6) * 0.70 + (20 / 1e6) * 2.80;
    expect(done!.usdcCharged).toBeCloseTo(expected, 8);
  });

  it("settlementTxHash is undefined (no per-call on-chain tx for credit-balance)", async () => {
    const adapter = createVeniceAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["token"]),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "deepseek-v3.2",
      messages: [{ role: "user", content: "code?" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("assembled text matches concatenated deltas", async () => {
    const parts = ["The ", "quick ", "brown ", "fox"];
    const adapter = createVeniceAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(parts),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "mistral-small-3-2-24b-instruct",
      messages: [{ role: "user", content: "sentence" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.text).toBe("The quick brown fox");
  });

  it("yields error event on non-200 HTTP response", async () => {
    const errorFetch = vi.fn(async () =>
      new Response("Unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;

    const adapter = createVeniceAdapter(MOCK_CFG, { fetchImpl: errorFetch });

    let errorEvent: string | undefined;
    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "error") errorEvent = ev.error;
    }

    expect(errorEvent).toContain("401");
  });

  it("models() returns non-empty list with expected entries", () => {
    const adapter = createVeniceAdapter(MOCK_CFG);
    const models = adapter.models();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "llama-3.3-70b")).toBe(true);
    expect(models.some((m) => m.id === "venice-uncensored-1-2")).toBe(true);
    expect(models.some((m) => m.id === "claude-sonnet-4-5")).toBe(true);
  });

  it("priceFor returns correct price priors for known models", () => {
    const adapter = createVeniceAdapter(MOCK_CFG);
    const price = adapter.priceFor("llama-3.3-70b");
    expect(price?.inputPricePerM).toBe(0.70);
    expect(price?.outputPricePerM).toBe(2.80);
  });

  it("priceFor returns undefined for unknown models", () => {
    const adapter = createVeniceAdapter(MOCK_CFG);
    expect(adapter.priceFor("gpt-99-ultra")).toBeUndefined();
  });

  it("supports() returns true for known models and false for unknown", () => {
    const adapter = createVeniceAdapter(MOCK_CFG);
    expect(adapter.supports("kimi-k2-6")).toBe(true);
    expect(adapter.supports("unknown-model-xyz")).toBe(false);
  });

  it("venice-uncensored-1-2 is tagged uncensored", () => {
    const adapter = createVeniceAdapter(MOCK_CFG);
    const m = adapter.models().find((x) => x.id === "venice-uncensored-1-2");
    expect(m?.tags).toContain("uncensored");
  });
});
