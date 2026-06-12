import { describe, it, expect, vi, afterEach } from "vitest";
import { createOpenRouterAdapter } from "./openrouter";
import type { AppConfig, CompletionResult } from "@/lib/types";
import type { OpenRouterDeps } from "./openrouter";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_CFG: AppConfig = {
  providerMode: "live",
  sessionBudgetUsd: 5,
  maxPaymentPerCallUsd: 0.1,
  network: "base-sepolia",
  walletPrivateKey: undefined,
  venice: { baseUrl: "https://api.venice.ai/api/v1" },
  hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
  anthropic: {},
  openrouter: {},
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
  cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
};

// The adapter reads OPENROUTER_API_KEY at call time; set it for the streaming
// tests and clean up after each so the "missing key" test sees it unset.
const OLD_KEY = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = OLD_KEY;
  vi.restoreAllMocks();
});

/**
 * Build a fake fetch returning an OpenAI-style SSE stream. `capture` receives the
 * parsed request body so tests can assert on the request shape.
 */
function makeSseFetch(
  deltas: string[],
  usage?: { prompt_tokens: number; completion_tokens: number },
  capture?: (body: Record<string, unknown>) => void,
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (capture && typeof init?.body === "string") {
      capture(JSON.parse(init.body) as Record<string, unknown>);
    }
    const lines: string[] = deltas.map(
      (content, i) =>
        `data: ${JSON.stringify({
          choices: [{ delta: { content }, finish_reason: null }],
          ...(i === deltas.length - 1 && usage ? { usage } : {}),
        })}\n\n`,
    );
    lines.push("data: [DONE]\n\n");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("openrouter adapter", () => {
  it("streams deltas then a terminal done event", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const deps: OpenRouterDeps = { fetchImpl: makeSseFetch(["Hello", " world", "!"]) };
    const adapter = createOpenRouterAdapter(MOCK_CFG, deps);

    const deltas: string[] = [];
    let done: CompletionResult | undefined;

    for await (const ev of adapter.stream({
      model: "anthropic/claude-opus-4.8",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      if (ev.type === "delta") deltas.push(ev.content);
      if (ev.type === "done") done = ev.result;
      if (ev.type === "error") throw new Error(`Unexpected error: ${ev.error}`);
    }

    expect(deltas).toEqual(["Hello", " world", "!"]);
    expect(done).toBeDefined();
  });

  it("done event has correct provider and paymentMode", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const adapter = createOpenRouterAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["answer"]),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "test" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.provider).toBe("openrouter");
    expect(done!.paymentMode).toBe("credit-balance");
  });

  it("usdcCharged is computed from SDK usage × price priors", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const usage = { prompt_tokens: 10, completion_tokens: 20 };
    const adapter = createOpenRouterAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["reply"], usage),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    // Sonnet 4.6: $3/1M in, $15/1M out.
    const expected = (10 / 1e6) * 3.0 + (20 / 1e6) * 15.0;
    expect(done!.usdcCharged).toBeCloseTo(expected, 8);
    expect(done!.inputTokens).toBe(10);
    expect(done!.outputTokens).toBe(20);
  });

  it("settlementTxHash is undefined (credit-balance, no on-chain tx)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const adapter = createOpenRouterAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["token"], { prompt_tokens: 5, completion_tokens: 5 }),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "anthropic/claude-opus-4.8",
      messages: [{ role: "user", content: "code?" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("assembled text matches concatenated deltas", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const parts = ["The ", "quick ", "brown ", "fox"];
    const adapter = createOpenRouterAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(parts),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "anthropic/claude-fable-5",
      messages: [{ role: "user", content: "sentence" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.text).toBe("The quick brown fox");
  });

  it("yields an error event without OPENROUTER_API_KEY (never silently 401s)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const adapter = createOpenRouterAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["unused"]),
    });

    let errorEvent: string | undefined;
    for await (const ev of adapter.stream({
      model: "anthropic/claude-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (ev.type === "error") errorEvent = ev.error;
    }

    expect(errorEvent).toContain("OPENROUTER_API_KEY");
  });

  it("yields an error event on non-200 HTTP response", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const errorFetch = vi.fn(async () =>
      new Response("Unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter(MOCK_CFG, { fetchImpl: errorFetch });

    let errorEvent: string | undefined;
    for await (const ev of adapter.stream({
      model: "anthropic/claude-opus-4.8",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "error") errorEvent = ev.error;
    }

    expect(errorEvent).toContain("401");
  });

  it("forwards temperature only for sampling-capable models", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let opusBody: Record<string, unknown> | undefined;
    let haikuBody: Record<string, unknown> | undefined;

    const opus = createOpenRouterAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["x"], undefined, (b) => (opusBody = b)),
    });
    for await (const ev of opus.stream({
      model: "anthropic/claude-opus-4.8",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    })) {
      void ev;
    }

    const haiku = createOpenRouterAdapter(MOCK_CFG, {
      fetchImpl: makeSseFetch(["x"], undefined, (b) => (haikuBody = b)),
    });
    for await (const ev of haiku.stream({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    })) {
      void ev;
    }

    // Opus 4.8 rejects sampling params upstream → temperature must be omitted.
    expect(opusBody!.temperature).toBeUndefined();
    // Haiku 4.5 accepts it → forwarded.
    expect(haikuBody!.temperature).toBe(0.7);
  });

  it("models() returns the full Claude lineup under OpenRouter slugs", () => {
    const adapter = createOpenRouterAdapter(MOCK_CFG);
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "anthropic/claude-haiku-4.5",
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-opus-4.8",
        "anthropic/claude-opus-4.7",
        "anthropic/claude-fable-5",
      ]),
    );
  });

  it("priceFor returns correct priors and undefined for unknown models", () => {
    const adapter = createOpenRouterAdapter(MOCK_CFG);
    expect(adapter.priceFor("anthropic/claude-opus-4.8")).toEqual({
      inputPricePerM: 5.0,
      outputPricePerM: 25.0,
    });
    expect(adapter.priceFor("anthropic/claude-sonnet-4-6")).toBeUndefined();
  });

  it("supports() is true for known slugs and false for unknown", () => {
    const adapter = createOpenRouterAdapter(MOCK_CFG);
    expect(adapter.supports("anthropic/claude-haiku-4.5")).toBe(true);
    expect(adapter.supports("claude-haiku-4-5")).toBe(false);
  });

  it("haiku is weak/cheap, fable carries reasoning", () => {
    const adapter = createOpenRouterAdapter(MOCK_CFG);
    const haiku = adapter.models().find((m) => m.id === "anthropic/claude-haiku-4.5");
    const fable = adapter.models().find((m) => m.id === "anthropic/claude-fable-5");
    expect(haiku?.tags).toContain("cheap");
    expect(fable?.tags).toContain("reasoning");
  });
});
