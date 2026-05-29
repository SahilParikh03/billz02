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
import { fetchWithX402Retry } from "@/payment/retry";

// ── Static model list ─────────────────────────────────────────────────────────
// Price is dynamic (from 402 response), so inputPricePerM/outputPricePerM are absent.
// ─────────────────────────────────────────────────────────────────────────────

// Only Llama-3.3 is reliably served by the hyperbolic-x402 endpoint. Verified
// 2026-05-29: DeepSeek-V3-0324 persistently returns upstream 503 ("server
// overloaded"), and DeepSeek-R1 returns 400 ("non-serverless model" — not
// available via this serverless endpoint at all). DeepSeek is offered through
// Surplus instead, which settles reliably. Don't list models that 500 — it just
// hands users broken terminals.
const MODELS: ModelInfo[] = [
  {
    id: "meta-llama/Llama-3.3-70B-Instruct",
    label: "Llama 3.3 70B",
    contextTokens: 128_000,
    tags: ["chat"],
  },
];

const SUPPORTED_IDS = new Set(MODELS.map((m) => m.id));

/** Rough token estimate (~1.3 tokens per whitespace-separated word). */
function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().split(/\s+/).filter(Boolean).length * 1.3));
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

  // Strict: only the exact ids we list and have verified. Loose substring
  // matching made Hyperbolic claim models it can't actually serve (e.g. any
  // "deepseek-*"), which is how a pinned Surplus/other-provider model could get
  // mis-routed here. Each provider owns exactly its listed ids.
  const supports = (model: string): boolean => SUPPORTED_IDS.has(model);

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

    // Non-streaming: Hyperbolic's x402 endpoint returns HTTP 500 on stream:true
    // (it errors before issuing the 402 challenge). We request the full response
    // and re-chunk it into word-level deltas below for a streaming UX.
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: false,
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
    });

    // Safe retry: only re-signs on a pre-settlement 402 payment-verification
    // failure (concurrent terminals sharing the wallet). Upstream 5xx are NOT
    // retried — they can occur after settlement, so retrying could double-charge.
    const attempt = await fetchWithX402Retry(() =>
      activeFetch(cfg.hyperbolic.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": crypto.randomUUID(),
        },
        body,
        signal: req.signal,
      }),
      { signal: req.signal },
    );

    if (!attempt.ok || !attempt.response) {
      yield {
        type: "error",
        error: `Hyperbolic HTTP ${attempt.status ?? 0}: ${attempt.errorText ?? "request failed"}`,
      };
      return;
    }
    const response = attempt.response;

    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      text = data.choices?.[0]?.message?.content ?? "";
      inputTokens = data.usage?.prompt_tokens;
      outputTokens = data.usage?.completion_tokens;

      // Re-chunk the full completion into word-level deltas for a streaming feel.
      const words = text.split(" ");
      for (let i = 0; i < words.length; i++) {
        if (req.signal?.aborted) break;
        yield { type: "delta", content: (i === 0 ? "" : " ") + words[i] };
      }
    } catch (err) {
      yield { type: "error", error: `Hyperbolic parse error: ${String(err)}` };
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
