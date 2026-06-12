import { describe, it, expect } from "vitest";
import { createAnthropicAdapter } from "./anthropic";
import type {
  AnthropicClientLike,
  AnthropicDeps,
  AnthropicMessageStream,
} from "./anthropic";
import type { AppConfig, CompletionResult } from "@/lib/types";

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
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
  cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
};

/**
 * Build a fake Anthropic SDK client that yields `text_delta` stream events and
 * resolves `finalMessage()` with the given usage. `capture` receives the params
 * passed to `stream()` so tests can assert on the request shape.
 */
function makeFakeClient(
  deltas: string[],
  usage?: { input_tokens: number; output_tokens: number },
  capture?: (params: Record<string, unknown>) => void,
): AnthropicClientLike {
  return {
    messages: {
      stream(params: Record<string, unknown>): AnthropicMessageStream {
        capture?.(params);
        async function* gen() {
          // A non-text event that must be ignored, then the text deltas.
          yield { type: "message_start" };
          for (const text of deltas) {
            yield { type: "content_block_delta", delta: { type: "text_delta", text } };
          }
        }
        const it = gen();
        return {
          [Symbol.asyncIterator]: () => it,
          finalMessage: async () => ({ usage }),
        };
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("anthropic adapter", () => {
  it("streams deltas then a terminal done event", async () => {
    const deps: AnthropicDeps = { client: makeFakeClient(["Hello", " world", "!"]) };
    const adapter = createAnthropicAdapter(MOCK_CFG, deps);

    const deltas: string[] = [];
    let done: CompletionResult | undefined;

    for await (const ev of adapter.stream({
      model: "claude-opus-4-8",
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
    const adapter = createAnthropicAdapter(MOCK_CFG, {
      client: makeFakeClient(["answer"]),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.provider).toBe("anthropic");
    expect(done!.paymentMode).toBe("credit-balance");
  });

  it("usdcCharged is computed from SDK usage × price priors", async () => {
    const usage = { input_tokens: 10, output_tokens: 20 };
    const adapter = createAnthropicAdapter(MOCK_CFG, {
      client: makeFakeClient(["reply"], usage),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "claude-sonnet-4-6",
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
    const adapter = createAnthropicAdapter(MOCK_CFG, {
      client: makeFakeClient(["token"], { input_tokens: 5, output_tokens: 5 }),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "code?" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("assembled text matches concatenated deltas", async () => {
    const parts = ["The ", "quick ", "brown ", "fox"];
    const adapter = createAnthropicAdapter(MOCK_CFG, {
      client: makeFakeClient(parts),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "claude-fable-5",
      messages: [{ role: "user", content: "sentence" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.text).toBe("The quick brown fox");
  });

  it("yields an error event when the SDK stream throws", async () => {
    const throwingClient: AnthropicClientLike = {
      messages: {
        stream(): AnthropicMessageStream {
          throw new Error("401 authentication_error");
        },
      },
    };
    const adapter = createAnthropicAdapter(MOCK_CFG, { client: throwingClient });

    let errorEvent: string | undefined;
    for await (const ev of adapter.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "error") errorEvent = ev.error;
    }

    expect(errorEvent).toContain("401");
  });

  it("forwards temperature only for sampling-capable models", async () => {
    let opusParams: Record<string, unknown> | undefined;
    let haikuParams: Record<string, unknown> | undefined;

    const opus = createAnthropicAdapter(MOCK_CFG, {
      client: makeFakeClient(["x"], undefined, (p) => (opusParams = p)),
    });
    for await (const ev of opus.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    })) {
      void ev;
    }

    const haiku = createAnthropicAdapter(MOCK_CFG, {
      client: makeFakeClient(["x"], undefined, (p) => (haikuParams = p)),
    });
    for await (const ev of haiku.stream({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    })) {
      void ev;
    }

    // Opus 4.8 rejects sampling params → temperature must be omitted.
    expect(opusParams!.temperature).toBeUndefined();
    // Haiku 4.5 accepts it → forwarded.
    expect(haikuParams!.temperature).toBe(0.7);
  });

  it("extracts system messages and maps roles to Anthropic shape", async () => {
    let params: Record<string, unknown> | undefined;
    const adapter = createAnthropicAdapter(MOCK_CFG, {
      client: makeFakeClient(["ok"], undefined, (p) => (params = p)),
    });

    for await (const ev of adapter.stream({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello." },
        { role: "user", content: "Bye" },
      ],
      maxTokens: 1234,
    })) {
      void ev;
    }

    expect(params!.system).toBe("You are terse.");
    expect(params!.max_tokens).toBe(1234);
    expect(params!.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Bye" },
    ]);
  });

  it("models() returns the full Claude lineup", () => {
    const adapter = createAnthropicAdapter(MOCK_CFG);
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-fable-5",
      ]),
    );
  });

  it("priceFor returns correct priors and undefined for unknown models", () => {
    const adapter = createAnthropicAdapter(MOCK_CFG);
    expect(adapter.priceFor("claude-opus-4-8")).toEqual({
      inputPricePerM: 5.0,
      outputPricePerM: 25.0,
    });
    expect(adapter.priceFor("gpt-99-ultra")).toBeUndefined();
  });

  it("supports() is true for known models and false for unknown", () => {
    const adapter = createAnthropicAdapter(MOCK_CFG);
    expect(adapter.supports("claude-haiku-4-5")).toBe(true);
    expect(adapter.supports("unknown-model-xyz")).toBe(false);
  });

  it("haiku is a weak/cheap tier model, opus/fable carry reasoning", () => {
    const adapter = createAnthropicAdapter(MOCK_CFG);
    const haiku = adapter.models().find((m) => m.id === "claude-haiku-4-5");
    const fable = adapter.models().find((m) => m.id === "claude-fable-5");
    expect(haiku?.tags).toContain("cheap");
    expect(fable?.tags).toContain("reasoning");
  });
});
