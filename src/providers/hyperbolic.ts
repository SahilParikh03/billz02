/**
 * Hyperbolic provider adapter — pure per-call x402 USDC settlement.
 *
 * Endpoint: POST ${cfg.hyperbolic.url}  (default: https://hyperbolic-x402.vercel.app/v1/chat/completions)
 * Protocol: canonical x402 — the server returns a 402 challenge, `wrapFetchWithPayment`
 *           signs a USDC-on-Base EIP-3009 transferWithAuthorization, retries, and the
 *           server settles via the configured facilitator.
 *
 * Price is DYNAMIC: Hyperbolic does not pre-publish a per-model price. The exact
 * USDC amount is returned in the `PaymentRequirements.maxAmountRequired` field of
 * the 402 response. We capture it via a custom `PaymentRequirementsSelector` closure
 * and convert to USD (÷ 1e6 for 6-decimal USDC).
 *
 * paymentMode: "x402-percall" — every inference call produces an on-chain tx.
 * settlementTxHash: from the `X-PAYMENT-RESPONSE` header after the 200 response.
 */

import { wrapFetchWithPayment } from "x402-fetch";
import type { PaymentRequirementsSelector } from "x402/client";
import type { PaymentRequirements } from "x402/types";
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

// ── Static model list ─────────────────────────────────────────────────────────
// Price is dynamic (from 402 response), so inputPricePerM/outputPricePerM are absent.
// ─────────────────────────────────────────────────────────────────────────────

const MODELS: ModelInfo[] = [
  {
    id: "llama-3.3-70b",
    label: "Llama 3.3 70B",
    contextTokens: 128_000,
    tags: ["chat"],
  },
  {
    id: "deepseek-v3",
    label: "DeepSeek V3",
    contextTokens: 64_000,
    tags: ["reasoning", "code"],
  },
  {
    id: "mistral-7b",
    label: "Mistral 7B",
    contextTokens: 32_000,
    tags: ["fast", "cheap"],
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

// ── Adapter deps (for test injection) ────────────────────────────────────────

export interface HyperbolicDeps {
  wrappedFetch?: typeof fetch;
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createHyperbolicAdapter(
  cfg: AppConfig,
  deps?: HyperbolicDeps,
): ProviderAdapter {
  const models = (): ModelInfo[] => MODELS;

  const priceFor = (_model: string): PricePrior | undefined =>
    // Price is dynamic — only available after the 402 challenge.
    undefined;

  const supports = (model: string): boolean => {
    if (SUPPORTED_IDS.has(model)) return true;
    const lower = model.toLowerCase();
    return lower.includes("llama") || lower.includes("deepseek") || lower.includes("mistral");
  };

  async function* stream(
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const start = Date.now();

    // Closure variable: the PaymentRequirements selected by the 402 negotiation.
    // Set by the selector below; used after the response to compute usdcCharged.
    let capturedRequirements: PaymentRequirements | undefined;

    // Build a selector that (a) picks the best requirement and (b) records it.
    const selector: PaymentRequirementsSelector = (reqs, _network, _scheme) => {
      // Prefer USDC on the configured network; fall back to first requirement.
      const preferred =
        reqs.find((r) => r.network === cfg.network) ??
        reqs.find((r) => r.network.startsWith("base")) ??
        reqs[0];
      if (preferred) capturedRequirements = preferred;
      return preferred ?? reqs[0];
    };

    // Determine which fetch implementation to use.
    // In tests, `deps.wrappedFetch` is injected directly (already "wrapped").
    // In production, we build the wrapped fetch lazily.
    // We use a loose function type here because wrapFetchWithPayment returns a
    // slightly narrower overload signature than `typeof fetch` (RequestInfo, not URL).
    let activeFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;

    if (deps?.wrappedFetch) {
      activeFetch = deps.wrappedFetch;
    } else {
      // Live path: wrap global fetch with the x402 payment layer.
      let signer;
      try {
        signer = await getSigner(cfg);
      } catch (err) {
        yield { type: "error", error: `Hyperbolic: failed to get signer — ${String(err)}` };
        return;
      }

      const maxValue = BigInt(Math.round(cfg.maxPaymentPerCallUsd * 1e6));
      activeFetch = wrapFetchWithPayment(
        globalThis.fetch,
        signer,
        maxValue,
        selector,
      );
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
      response = await activeFetch(cfg.hyperbolic.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
        body,
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", error: `Hyperbolic fetch failed: ${String(err)}` };
      return;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "(no body)");
      yield {
        type: "error",
        error: `Hyperbolic HTTP ${response.status}: ${errText}`,
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "Hyperbolic: empty response body" };
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
          if (usage.completion_tokens != null)
            outputTokens = usage.completion_tokens;
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
      yield { type: "error", error: `Hyperbolic stream error: ${String(err)}` };
      return;
    }

    // Decode the settlement receipt from the response header.
    const paymentResponseHeader = response.headers.get("X-PAYMENT-RESPONSE");
    const { settlementTxHash } = decodeReceipt(paymentResponseHeader);

    // Compute USDC charged from the captured PaymentRequirements.
    // maxAmountRequired is a string of USDC base units (6 decimals).
    let usdcCharged = 0;
    if (capturedRequirements?.maxAmountRequired) {
      try {
        usdcCharged = Number(capturedRequirements.maxAmountRequired) / 1e6;
      } catch {
        usdcCharged = 0;
      }
    }

    const inToks = inputTokens ?? approxTokens(req.messages.map((m) => m.content).join(" "));
    const outToks = outputTokens ?? approxTokens(text);

    const result: CompletionResult = {
      provider: "hyperbolic",
      model: req.model,
      text,
      inputTokens: inToks,
      outputTokens: outToks,
      usdcCharged: Number(usdcCharged.toFixed(8)),
      settlementTxHash,
      paymentMode: "x402-percall",
      latencyMs: Date.now() - start,
    };

    yield { type: "done", result };
  }

  return {
    id: "hyperbolic",
    displayName: "Hyperbolic (x402 per-call)",
    models,
    priceFor,
    supports,
    stream,
  };
}
