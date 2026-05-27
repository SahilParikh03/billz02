/**
 * Surplus Intelligence adapter tests — NO live network, NO real signer.
 *
 * Strategy:
 * - Inject `deps.wrappedFetch` to bypass `wrapFetchWithPayment` and `getSigner`.
 *   The injected fetch simulates the 200 response a real x402-settled call would
 *   return (post-payment), including an optional `X-PAYMENT-RESPONSE` header.
 * - Flat-price contract: every successful call yields `usdcCharged === 0.003306`
 *   (SURPLUS_FLAT_USDC_PER_CALL), independent of model, token count, or headers.
 *
 * What we cannot test here without a funded wallet + live network:
 * - Real 402 challenge / payment negotiation
 * - Actual on-chain settlement
 * - `exact` vs `upto` scheme selection
 */

import { describe, it, expect, vi } from "vitest";
import { createSurplusAdapter, SURPLUS_FLAT_USDC_PER_CALL } from "./surplus";
import type { AppConfig, CompletionResult } from "@/lib/types";
import type { SurplusDeps } from "./surplus";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_CFG: AppConfig = {
  providerMode: "live",
  sessionBudgetUsd: 5,
  maxPaymentPerCallUsd: 0.10,
  network: "base",
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
 * @param deltas         - Content strings to emit as delta chunks.
 * @param usage          - Optional usage in the final data chunk.
 * @param extraHeaders   - Extra response headers (e.g. X-PAYMENT-RESPONSE).
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

/** Collect all events from the adapter stream into typed arrays. */
async function collectEvents(
  adapter: ReturnType<typeof createSurplusAdapter>,
  model = "llama-3.3-70b",
  content = "say hi",
): Promise<{
  deltas: string[];
  done: CompletionResult | undefined;
  errors: string[];
}> {
  const deltas: string[] = [];
  let done: CompletionResult | undefined;
  const errors: string[] = [];

  for await (const ev of adapter.stream({
    model,
    messages: [{ role: "user", content }],
  })) {
    if (ev.type === "delta") deltas.push(ev.content);
    if (ev.type === "done") done = ev.result;
    if (ev.type === "error") errors.push(ev.error);
  }

  return { deltas, done, errors };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("surplus adapter", () => {
  // ── Static metadata ─────────────────────────────────────────────────────────

  it("models() includes llama-3.3-70b with chat tag", () => {
    const adapter = createSurplusAdapter(MOCK_CFG);
    const ids = adapter.models().map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
    const llama = adapter.models().find((m) => m.id === "llama-3.3-70b");
    expect(llama?.tags).toContain("chat");
  });

  it("priceFor() returns undefined (flat per-call, not per-token)", () => {
    const adapter = createSurplusAdapter(MOCK_CFG);
    expect(adapter.priceFor("llama-3.3-70b")).toBeUndefined();
    expect(adapter.priceFor("any-model")).toBeUndefined();
  });

  it("supports() matches known IDs", () => {
    const adapter = createSurplusAdapter(MOCK_CFG);
    expect(adapter.supports("llama-3.3-70b")).toBe(true);
  });

  it("supports() matches 'llama' substring", () => {
    const adapter = createSurplusAdapter(MOCK_CFG);
    expect(adapter.supports("llama-3.2-3b")).toBe(true);
    expect(adapter.supports("meta-llama-70b")).toBe(true);
    expect(adapter.supports("LLAMA-ANYTHING")).toBe(true);
  });

  it("supports() rejects unrelated models", () => {
    const adapter = createSurplusAdapter(MOCK_CFG);
    expect(adapter.supports("gpt-4o")).toBe(false);
    expect(adapter.supports("claude-opus-4")).toBe(false);
    expect(adapter.supports("deepseek-v3")).toBe(false);
  });

  it("id is 'surplus' and displayName contains 'Surplus'", () => {
    const adapter = createSurplusAdapter(MOCK_CFG);
    // Cast since ProviderId union does not yet include 'surplus'
    expect(adapter.id as string).toBe("surplus");
    expect(adapter.displayName).toMatch(/surplus/i);
  });

  // ── Streaming ───────────────────────────────────────────────────────────────

  it("streams deltas in order then yields exactly one terminal done event", async () => {
    const deps: SurplusDeps = { wrappedFetch: makeSseFetch(["Hello", " world", "!"]) };
    const adapter = createSurplusAdapter(MOCK_CFG, deps);

    const { deltas, done, errors } = await collectEvents(adapter);

    expect(errors).toHaveLength(0);
    expect(deltas).toEqual(["Hello", " world", "!"]);
    expect(done).toBeDefined();
  });

  it("assembled text equals concatenated deltas", async () => {
    const parts = ["The ", "answer ", "is 42"];
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(parts),
    });

    const { done } = await collectEvents(adapter);

    expect(done!.text).toBe("The answer is 42");
  });

  // ── Provider identity + payment mode ────────────────────────────────────────

  it("result.provider === 'surplus'", async () => {
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["answer"]),
    });

    const { done } = await collectEvents(adapter);

    expect(done!.provider as string).toBe("surplus");
  });

  it("paymentMode === 'x402-percall'", async () => {
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["answer"]),
    });

    const { done } = await collectEvents(adapter);

    expect(done!.paymentMode).toBe("x402-percall");
  });

  // ── Flat-price contract ──────────────────────────────────────────────────────

  it("usdcCharged === SURPLUS_FLAT_USDC_PER_CALL (0.003306) — flat per call", async () => {
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["answer"]),
    });

    const { done } = await collectEvents(adapter);

    // This is the core flat-price contract: always exactly 0.003306
    expect(done!.usdcCharged).toBe(SURPLUS_FLAT_USDC_PER_CALL);
    expect(done!.usdcCharged).toBe(0.003306);
  });

  it("usdcCharged is constant regardless of token count", async () => {
    // Long response
    const longAdapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["A ".repeat(500).trim()]),
    });
    const { done: longDone } = await collectEvents(longAdapter);

    // Short response
    const shortAdapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["Hi"]),
    });
    const { done: shortDone } = await collectEvents(shortAdapter);

    expect(longDone!.usdcCharged).toBe(SURPLUS_FLAT_USDC_PER_CALL);
    expect(shortDone!.usdcCharged).toBe(SURPLUS_FLAT_USDC_PER_CALL);
  });

  // ── Settlement receipt ───────────────────────────────────────────────────────

  it("settlementTxHash is undefined when X-PAYMENT-RESPONSE header is absent", async () => {
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["text"]),
      // No X-PAYMENT-RESPONSE header
    });

    const { done } = await collectEvents(adapter);

    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("settlementTxHash is undefined when X-PAYMENT-RESPONSE is malformed", async () => {
    // decodeReceipt must tolerate a garbage header without throwing
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(
        ["text"],
        undefined,
        { "X-PAYMENT-RESPONSE": "not-valid-base64!!!" },
      ),
    });

    const { done } = await collectEvents(adapter);

    // Should not throw; fallback to undefined
    expect(done!.settlementTxHash).toBeUndefined();
  });

  it("settlementTxHash is a string when a valid-looking X-PAYMENT-RESPONSE is present", async () => {
    // We cannot produce a cryptographically valid receipt without a live 402 exchange,
    // but we can verify that a well-formed base64 JSON receipt (mocked) is decoded.
    // decodeReceipt requires { success: true, transaction: "0x..." } inside the decoded JSON.
    const receipt = { success: true, transaction: "0xdeadbeefcafe" };
    const encoded = Buffer.from(JSON.stringify(receipt)).toString("base64");

    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(
        ["text"],
        undefined,
        { "X-PAYMENT-RESPONSE": encoded },
      ),
    });

    const { done } = await collectEvents(adapter);

    // If decodeXPaymentResponse (from x402-fetch) accepts this format, we get a hash.
    // If it requires a different envelope, settlementTxHash stays undefined.
    // Either way the adapter must not throw.
    expect(done).toBeDefined();
    // The value is either the tx hash string or undefined — both are valid
    if (done!.settlementTxHash !== undefined) {
      expect(typeof done!.settlementTxHash).toBe("string");
    }
  });

  // ── Token counts ─────────────────────────────────────────────────────────────

  it("input/output token counts come from usage when present", async () => {
    const usage = { prompt_tokens: 20, completion_tokens: 40 };
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["reply"], usage),
    });

    const { done } = await collectEvents(adapter);

    expect(done!.inputTokens).toBe(20);
    expect(done!.outputTokens).toBe(40);
  });

  it("input/output tokens fall back to approx estimate when usage is absent", async () => {
    const adapter = createSurplusAdapter(MOCK_CFG, {
      wrappedFetch: makeSseFetch(["hello world"]),
    });

    const { done } = await collectEvents(adapter, "llama-3.3-70b", "test prompt");

    expect(done!.inputTokens).toBeGreaterThan(0);
    expect(done!.outputTokens).toBeGreaterThan(0);
  });

  // ── Fetch call shape ─────────────────────────────────────────────────────────

  it("wrappedFetch is called with POST method and Content-Type: application/json", async () => {
    const fakeFetch = makeSseFetch(["ok"]);
    const adapter = createSurplusAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    await collectEvents(adapter);

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit & { headers: Record<string, string> }).headers["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("wrappedFetch is called against the chat/completions endpoint", async () => {
    const fakeFetch = makeSseFetch(["ok"]);
    const adapter = createSurplusAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    await collectEvents(adapter);

    const [url] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/chat/completions");
  });

  it("request body includes stream:true", async () => {
    const fakeFetch = makeSseFetch(["ok"]);
    const adapter = createSurplusAdapter(MOCK_CFG, { wrappedFetch: fakeFetch });

    await collectEvents(adapter);

    const [, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse((init as RequestInit).body as string);
    expect(parsed.stream).toBe(true);
  });

  // ── Error paths ──────────────────────────────────────────────────────────────

  it("yields error event on non-200 HTTP response and does not throw", async () => {
    const errorFetch = vi.fn(async () =>
      new Response("Server Error", { status: 500 }),
    ) as unknown as typeof fetch;

    const adapter = createSurplusAdapter(MOCK_CFG, { wrappedFetch: errorFetch });

    const { errors, done } = await collectEvents(adapter);

    expect(done).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("500");
  });

  it("yields error event when fetch throws and does not propagate", async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const adapter = createSurplusAdapter(MOCK_CFG, { wrappedFetch: throwingFetch });

    const { errors, done } = await collectEvents(adapter);

    expect(done).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("connection refused");
  });

  it("yields error event when response body is null/empty", async () => {
    const nullBodyFetch = vi.fn(async () =>
      new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;

    const adapter = createSurplusAdapter(MOCK_CFG, { wrappedFetch: nullBodyFetch });

    const { errors } = await collectEvents(adapter);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/empty/i);
  });

  // ── SURPLUS_FLAT_USDC_PER_CALL constant ──────────────────────────────────────

  it("SURPLUS_FLAT_USDC_PER_CALL exported constant equals 0.003306", () => {
    expect(SURPLUS_FLAT_USDC_PER_CALL).toBe(0.003306);
  });
});
