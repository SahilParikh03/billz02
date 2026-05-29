/**
 * Hyperbolic adapter tests — NO live network, NO real signer.
 *
 * Strategy:
 * - Inject `deps.wrappedFetch` to bypass `wrapFetchWithPayment` and `getSigner`.
 *   The injected fetch simulates the 200 response a real x402-settled call would
 *   return (post-payment), including the `X-PAYMENT-RESPONSE` header.
 * - The adapter requests a NON-streaming completion (Hyperbolic's x402 endpoint
 *   returns HTTP 500 on stream:true) and re-chunks the full text into word-level
 *   deltas, so the mock returns a single OpenAI chat.completion JSON object.
 *
 * What we cannot test here without a funded wallet + live network:
 * - Real 402 challenge / payment negotiation
 * - Actual on-chain settlement
 * - Selector choosing between multiple PaymentRequirements
 */

import { describe, it, expect, vi } from "vitest";
import { createHyperbolicAdapter } from "./hyperbolic";
import type { AppConfig, CompletionResult } from "@/lib/types";
import type { HyperbolicDeps } from "./hyperbolic";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_CFG: AppConfig = {
  providerMode: "live",
  sessionBudgetUsd: 5,
  maxPaymentPerCallUsd: 0.10,
  network: "base-sepolia",
  facilitatorUrl: "https://x402.org/facilitator",
  // No real private key — getSigner() must not be reached via injected fetch
  walletPrivateKey: undefined,
  venice: { baseUrl: "https://api.venice.ai/api/v1" },
  hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
  cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
};

/**
 * Build a mock fetch that returns a non-streaming OpenAI chat.completion JSON
 * response (the post-x402-settlement 200 shape).
 *
 * @param content        - The full assistant message content.
 * @param usage          - Optional usage block.
 * @param extraHeaders   - Extra response headers (e.g. X-PAYMENT-RESPONSE).
 */
function makeJsonFetch(
  content: string,
  usage?: { prompt_tokens: number; completion_tokens: number },
  extraHeaders: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        model: "meta-llama/Llama-3.3-70B-Instruct",
        choices: [
          { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
        ],
        ...(usage ? { usage } : {}),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...extraHeaders },
      },
    );
  }) as unknown as typeof fetch;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("hyperbolic adapter", () => {
  it("re-chunks the completion into word deltas then yields a terminal done event", async () => {
    const fakeFetch = makeJsonFetch("Hello there friend");
    const deps: HyperbolicDeps = { wrappedFetch: fakeFetch };
    const adapter = createHyperbolicAdapter(MOCK_CFG, deps);

    const deltas: string[] = [];
    let done: CompletionResult | undefined;

    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "say hi" }],
    })) {
      if (ev.type === "delta") deltas.push(ev.content);
      if (ev.type === "done") done = ev.result;
      if (ev.type === "error") throw new Error(`Unexpected error: ${ev.error}`);
    }

    expect(deltas.join("")).toBe("Hello there friend");
    expect(deltas.length).toBeGreaterThan(1);
    expect(done).toBeDefined();
  });

  it("done event has correct provider and paymentMode", async () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeJsonFetch("answer"),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.provider).toBe("hyperbolic");
    expect(done!.paymentMode).toBe("x402-percall");
  });

  it("usdcCharged is >= 0 (dynamic; 0 when no capturedRequirements)", async () => {
    // When injecting wrappedFetch, the selector never runs, so capturedRequirements
    // stays undefined → usdcCharged defaults to 0. This is correct testnet behaviour.
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeJsonFetch("token"),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "q" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.usdcCharged).toBeGreaterThanOrEqual(0);
  });

  it("settlementTxHash is undefined when X-PAYMENT-RESPONSE header is absent", async () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeJsonFetch("text"),
      // No X-PAYMENT-RESPONSE header → decodeReceipt returns {}
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("settlementTxHash is undefined when X-PAYMENT-RESPONSE is malformed", async () => {
    // decodeReceipt must tolerate an invalid/garbage header without throwing.
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeJsonFetch("text", undefined, {
        "X-PAYMENT-RESPONSE": "not-valid-base64!!!",
      }),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    // Should not throw; settlementTxHash falls back to undefined
    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("assembled text equals the upstream completion content", async () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeJsonFetch("The answer is 42"),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "answer?" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.text).toBe("The answer is 42");
  });

  it("input/output token counts come from usage when present", async () => {
    const usage = { prompt_tokens: 15, completion_tokens: 30 };
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeJsonFetch("reply", usage),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "count me" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.inputTokens).toBe(15);
    expect(done!.outputTokens).toBe(30);
  });

  it("requests a non-streaming completion (stream:false)", async () => {
    const fakeFetch = makeJsonFetch("ok");
    const adapter = createHyperbolicAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    for await (const _ of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "test" }],
    })) { /* consume */ }

    const [, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse((init as RequestInit).body as string);
    expect(parsed.stream).toBe(false);
  });

  it("wrappedFetch is called with the correct URL and method", async () => {
    const fakeFetch = makeJsonFetch("ok");
    const adapter = createHyperbolicAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    for await (const _ of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "test" }],
    })) { /* consume */ }

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(MOCK_CFG.hyperbolic.url);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("X-Request-ID header is sent with a valid UUID", async () => {
    const fakeFetch = makeJsonFetch("ok");
    const adapter = createHyperbolicAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    for await (const _ of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "test" }],
    })) { /* consume */ }

    const [, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    const requestId = headers["X-Request-ID"];
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("yields error event on non-200 HTTP response", async () => {
    const errorFetch = vi.fn(async () =>
      new Response("Payment Required", { status: 402 }),
    ) as unknown as typeof fetch;

    const adapter = createHyperbolicAdapter(MOCK_CFG, { wrappedFetch: errorFetch });

    let errorEvent: string | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "error") errorEvent = ev.error;
    }

    expect(errorEvent).toContain("402");
  });

  it("yields error event when fetch throws", async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error("network timeout");
    }) as unknown as typeof fetch;

    const adapter = createHyperbolicAdapter(MOCK_CFG, { wrappedFetch: throwingFetch });

    let errorEvent: string | undefined;
    for await (const ev of adapter.stream({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "error") errorEvent = ev.error;
    }

    expect(errorEvent).toContain("network timeout");
  });

  it("models() returns only Llama-3.3 (DeepSeek endpoints are dead — see adapter note)", () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG);
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toContain("meta-llama/Llama-3.3-70B-Instruct");
    expect(ids).not.toContain("deepseek-ai/DeepSeek-V3-0324");
    expect(ids).not.toContain("deepseek-ai/DeepSeek-R1");
  });

  it("priceFor() returns undefined (dynamic pricing)", () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG);
    expect(adapter.priceFor("meta-llama/Llama-3.3-70B-Instruct")).toBeUndefined();
  });

  it("supports() is strict — only the exact advertised id, no substring matching", () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG);
    expect(adapter.supports("meta-llama/Llama-3.3-70B-Instruct")).toBe(true);
    // No longer claims models it can't actually serve (this caused mis-routing).
    expect(adapter.supports("deepseek-ai/DeepSeek-V3-0324")).toBe(false);
    expect(adapter.supports("deepseek-ai/DeepSeek-R1")).toBe(false);
    expect(adapter.supports("llama-3.2-3b")).toBe(false);
    expect(adapter.supports("Qwen/Qwen3-Coder-480B-A35B-Instruct")).toBe(false);
    expect(adapter.supports("gpt-4o")).toBe(false);
  });

  it("usdcCharged computation: 50000 base units = 0.05 USDC", () => {
    // Validates the conversion formula used in the adapter independently.
    const maxAmountRequired = "50000";
    const usdcCharged = Number(maxAmountRequired) / 1e6;
    expect(usdcCharged).toBeCloseTo(0.05, 6);
  });
});
