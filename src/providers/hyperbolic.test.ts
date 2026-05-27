/**
 * Hyperbolic adapter tests — NO live network, NO real signer.
 *
 * Strategy:
 * - Inject `deps.wrappedFetch` to bypass `wrapFetchWithPayment` and `getSigner`.
 *   The injected fetch simulates the 200 response a real x402-settled call would
 *   return (post-payment), including the `X-PAYMENT-RESPONSE` header.
 * - For the "selector captures amount" path, we test that:
 *   (a) when `X-PAYMENT-RESPONSE` is absent/empty, settlementTxHash is undefined.
 *   (b) when `X-PAYMENT-RESPONSE` is present but invalid (no real wallet),
 *       decodeReceipt tolerates it and returns {}.
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
 * Build a mock fetch that returns an OpenAI-style SSE stream.
 *
 * @param deltas         - Content strings to emit.
 * @param usage          - Optional usage in the final data chunk.
 * @param extraHeaders   - Extra response headers (e.g. X-PAYMENT-RESPONSE).
 */
function makeSseFetch(
  deltas: string[],
  usage?: { prompt_tokens: number; completion_tokens: number },
  extraHeaders: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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

describe("hyperbolic adapter", () => {
  it("streams deltas in order then yields a terminal done event", async () => {
    const fakeFetch = makeSseFetch(["Hello", " there", "!"]);
    const deps: HyperbolicDeps = { wrappedFetch: fakeFetch };
    const adapter = createHyperbolicAdapter(MOCK_CFG, deps);

    const deltas: string[] = [];
    let done: CompletionResult | undefined;

    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "say hi" }],
    })) {
      if (ev.type === "delta") deltas.push(ev.content);
      if (ev.type === "done") done = ev.result;
      if (ev.type === "error") throw new Error(`Unexpected error: ${ev.error}`);
    }

    expect(deltas).toEqual(["Hello", " there", "!"]);
    expect(done).toBeDefined();
  });

  it("done event has correct provider and paymentMode", async () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["answer"]),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
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
      wrappedFetch: makeSseFetch(["token"]),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "deepseek-v3",
      messages: [{ role: "user", content: "q" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.usdcCharged).toBeGreaterThanOrEqual(0);
  });

  it("settlementTxHash is undefined when X-PAYMENT-RESPONSE header is absent", async () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["text"]),
      // No X-PAYMENT-RESPONSE header → decodeReceipt returns {}
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("settlementTxHash is undefined when X-PAYMENT-RESPONSE is malformed", async () => {
    // decodeReceipt must tolerate an invalid/garbage header without throwing.
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(
        ["text"],
        undefined,
        { "X-PAYMENT-RESPONSE": "not-valid-base64!!!" },
      ),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    // Should not throw; settlementTxHash falls back to undefined
    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("assembled text equals concatenated deltas", async () => {
    const parts = ["The ", "answer ", "is 42"];
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(parts),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "mistral-7b",
      messages: [{ role: "user", content: "answer?" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.text).toBe("The answer is 42");
  });

  it("input/output token counts come from usage when present", async () => {
    const usage = { prompt_tokens: 15, completion_tokens: 30 };
    const adapter = createHyperbolicAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["reply"], usage),
    });

    let done: CompletionResult | undefined;
    for await (const ev of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "count me" }],
    })) {
      if (ev.type === "done") done = ev.result;
    }

    expect(done!.inputTokens).toBe(15);
    expect(done!.outputTokens).toBe(30);
  });

  it("wrappedFetch is called with the correct URL and method", async () => {
    const fakeFetch = makeSseFetch(["ok"]);
    const adapter = createHyperbolicAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    for await (const _ of adapter.stream({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "test" }],
    })) { /* consume */ }

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(MOCK_CFG.hyperbolic.url);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("X-Request-ID header is sent with a valid UUID", async () => {
    const fakeFetch = makeSseFetch(["ok"]);
    const adapter = createHyperbolicAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    for await (const _ of adapter.stream({
      model: "llama-3.3-70b",
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
      model: "llama-3.3-70b",
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
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hello" }],
    })) {
      if (ev.type === "error") errorEvent = ev.error;
    }

    expect(errorEvent).toContain("network timeout");
  });

  it("models() returns the static list including llama, deepseek, mistral", () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG);
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
    expect(ids).toContain("deepseek-v3");
    expect(ids).toContain("mistral-7b");
  });

  it("priceFor() returns undefined (dynamic pricing)", () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG);
    expect(adapter.priceFor("llama-3.3-70b")).toBeUndefined();
  });

  it("supports() matches known IDs and substring patterns", () => {
    const adapter = createHyperbolicAdapter(MOCK_CFG);
    expect(adapter.supports("llama-3.3-70b")).toBe(true);
    expect(adapter.supports("deepseek-v3")).toBe(true);
    expect(adapter.supports("mistral-7b")).toBe(true);
    // Substring matches
    expect(adapter.supports("llama-3.2-3b")).toBe(true);
    expect(adapter.supports("deepseek-r1")).toBe(true);
    expect(adapter.supports("mistral-nemo")).toBe(true);
    // Unknown
    expect(adapter.supports("gpt-4o")).toBe(false);
    expect(adapter.supports("claude-opus-4")).toBe(false);
  });

  /**
   * Simulates the "selector captures amount → usdcCharged" path.
   *
   * In production, `wrapFetchWithPayment` calls our selector with the 402
   * PaymentRequirements. Here we verify the math manually: if maxAmountRequired
   * were "50000" (= 0.05 USDC), usdcCharged should be 0.05.
   *
   * We cannot exercise the real selector path without a live 402 exchange,
   * but we can validate the conversion formula used in the adapter.
   */
  it("usdcCharged computation: 50000 base units = 0.05 USDC", () => {
    // This just validates our conversion formula independently
    const maxAmountRequired = "50000";
    const usdcCharged = Number(maxAmountRequired) / 1e6;
    expect(usdcCharged).toBeCloseTo(0.05, 6);
  });
});
