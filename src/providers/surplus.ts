/**
 * Surplus Intelligence provider adapter — flat per-call x402 USDC settlement.
 *
 * Endpoint:
 *   Base URL: process.env.SURPLUS_BASE_URL ?? "https://www.surplusintelligence.ai/x402/api/inference/v1"
 *   Chat:     ${base}/chat/completions
 *
 * IMPORTANT — Base URL caveat: the exact base URL above is INFERRED from the dossier's
 * reference to its `/x402/api/inference/v1/models` discovery path. It is NOT directly
 * quoted on the indexed Bazaar page. Verify against the live Bazaar listing before
 * connecting to mainnet.
 *
 * Protocol: canonical x402 — the server returns a 402 challenge, `wrapFetchWithPayment`
 *           signs a USDC-on-Base EIP-3009 transferWithAuthorization, retries, and the
 *           server settles via the configured facilitator.
 *
 * Price is FLAT: $0.003306 USDC per call on Base mainnet (eip155:8453). Unlike
 * Hyperbolic (dynamic per-token), every successful call charges exactly this constant.
 * `priceFor()` returns `undefined` because the charge is per-call, not per-token.
 * The x402-fetch flow handles both `exact` and `upto` schemes transparently.
 *
 * paymentMode: "x402-percall" — every inference call produces an on-chain tx.
 * settlementTxHash: from the `X-PAYMENT-RESPONSE` header after the 200 response.
 */

import { wrapFetchWithPayment } from "x402-fetch";
import type {
  AppConfig,
  CompletionResult,
  ModelInfo,
  PricePrior,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "@/lib/types";
import { getSigner } from "@/payment/wallet";
import { decodeReceipt } from "@/payment/facilitator";

// ── Flat per-call price ───────────────────────────────────────────────────────
// This is a constant — Surplus charges exactly this per inference call regardless
// of model or token count. $0.003306 USDC on Base mainnet (eip155:8453).
export const SURPLUS_FLAT_USDC_PER_CALL = 0.003306;

// ── Static model list ──────────────────────────────────────────────────────────
// inputPricePerM/outputPricePerM are absent because Surplus charges per-call, not
// per-token. Models beyond llama-3.3-70b are discoverable at GET ${base}/models.
// ─────────────────────────────────────────────────────────────────────────────

const MODELS: ModelInfo[] = [
  {
    id: "llama-3.3-70b",
    label: "Llama 3.3 70B (Surplus)",
    contextTokens: 128_000,
    tags: ["chat"],
  },
];

const SUPPORTED_IDS = new Set(MODELS.map((m) => m.id));

/** Rough token estimate (~1.3 tokens per whitespace-separated word). */
function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

/**
 * Parse OpenAI-style SSE from a ReadableStream<Uint8Array>.
 * Yields each parsed JSON object from `data: {...}` lines.
 * Stops (and does not yield) the sentinel `data: [DONE]` line.
 */
async function* parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // Malformed chunk — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Adapter deps (for test injection) ─────────────────────────────────────────

export interface SurplusDeps {
  wrappedFetch?: typeof fetch;
}

// ── Adapter factory ────────────────────────────────────────────────────────────

export function createSurplusAdapter(
  cfg: AppConfig,
  deps?: SurplusDeps,
): ProviderAdapter {
  // Read base URL from env; default is INFERRED — must be verified against live Bazaar listing.
  const baseUrl =
    process.env.SURPLUS_BASE_URL ??
    "https://www.surplusintelligence.ai/x402/api/inference/v1";
  const chatUrl = `${baseUrl}/chat/completions`;

  const models = (): ModelInfo[] => MODELS;

  // Flat per-call pricing: not expressed as per-token, so priceFor returns undefined.
  const priceFor = (_model: string): PricePrior | undefined => undefined;

  const supports = (model: string): boolean => {
    if (SUPPORTED_IDS.has(model)) return true;
    return model.toLowerCase().includes("llama");
  };

  async function* stream(
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const start = Date.now();

    // Determine which fetch implementation to use.
    // In tests, `deps.wrappedFetch` is injected directly (already "wrapped").
    // In production, we build the wrapped fetch lazily.
    let activeFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;

    if (deps?.wrappedFetch) {
      activeFetch = deps.wrappedFetch;
    } else {
      // Live path: wrap global fetch with the x402 payment layer.
      // Surplus uses flat per-call pricing — no selector needed (price is not dynamic).
      let signer;
      try {
        signer = await getSigner(cfg);
      } catch (err) {
        yield { type: "error", error: `Surplus: failed to get signer — ${String(err)}` };
        return;
      }

      const maxValue = BigInt(Math.round(cfg.maxPaymentPerCallUsd * 1e6));
      activeFetch = wrapFetchWithPayment(globalThis.fetch, signer, maxValue);
    }

    const requestId = crypto.randomUUID();

    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
    });

    let response: Response;
    try {
      response = await activeFetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
        body,
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", error: `Surplus fetch failed: ${String(err)}` };
      return;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "(no body)");
      yield {
        type: "error",
        error: `Surplus HTTP ${response.status}: ${errText}`,
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "Surplus: empty response body" };
      return;
    }

    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      for await (const chunk of parseOpenAiSse(response.body)) {
        // Usage (may appear in a final chunk with empty delta)
        const usage = chunk.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        if (usage) {
          if (usage.prompt_tokens != null) inputTokens = usage.prompt_tokens;
          if (usage.completion_tokens != null) outputTokens = usage.completion_tokens;
        }

        // Delta content
        const choices = chunk.choices as Array<{
          delta?: { content?: string };
          finish_reason?: string | null;
        }> | undefined;
        if (choices && choices.length > 0) {
          const content = choices[0].delta?.content;
          if (content) {
            text += content;
            yield { type: "delta", content };
          }
        }
      }
    } catch (err) {
      yield { type: "error", error: `Surplus stream error: ${String(err)}` };
      return;
    }

    // Decode the settlement receipt from the response header.
    const paymentResponseHeader = response.headers.get("X-PAYMENT-RESPONSE");
    const { settlementTxHash } = decodeReceipt(paymentResponseHeader);

    // Flat per-call price: always SURPLUS_FLAT_USDC_PER_CALL, regardless of token count.
    // The x402 payment negotiation may charge up to cfg.maxPaymentPerCallUsd, but the
    // Bazaar listing price is exactly this constant.
    const usdcCharged = SURPLUS_FLAT_USDC_PER_CALL;

    const inToks = inputTokens ?? approxTokens(req.messages.map((m) => m.content).join(" "));
    const outToks = outputTokens ?? approxTokens(text);

    const result: CompletionResult = {
      provider: "surplus",
      model: req.model,
      text,
      inputTokens: inToks,
      outputTokens: outToks,
      usdcCharged,
      settlementTxHash,
      paymentMode: "x402-percall",
      latencyMs: Date.now() - start,
    };

    yield { type: "done", result };
  }

  return {
    id: "surplus",
    displayName: "Surplus Intelligence (x402 flat per-call)",
    models,
    priceFor,
    supports,
    stream,
  };
}
