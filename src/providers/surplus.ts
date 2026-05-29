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
import { fetchWithX402Retry } from "@/payment/retry";

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
    id: "gpt-4o-mini",
    label: "GPT-4o Mini (Surplus)",
    contextTokens: 128_000,
    tags: ["fast", "cheap", "chat"],
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2 (Surplus)",
    contextTokens: 128_000,
    tags: ["reasoning", "code"],
  },
  {
    // DeepSeek served via Surplus — Hyperbolic's DeepSeek endpoints are dead
    // (see hyperbolic.ts). Surplus serves it and settles reliably.
    id: "deepseek-v3.2",
    label: "DeepSeek V3.2 (Surplus)",
    contextTokens: 128_000,
    tags: ["reasoning", "code"],
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

// ── x402 challenge normalization ──────────────────────────────────────────────

/** CAIP-2 chain ids → the short network names this x402-fetch version accepts. */
const CAIP_TO_X402_NETWORK: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
};

/**
 * Surplus emits an x402 **v2** 402 challenge, but x402-fetch 1.2.0 parses each
 * `accepts[]` entry against the canonical **v1** `PaymentRequirementsSchema`.
 * Surplus's entries differ in three ways that make that parse throw:
 *   1. `network` is the CAIP-2 id "eip155:8453" (schema wants the short "base").
 *   2. the amount field is `amount` (schema wants `maxAmountRequired`).
 *   3. `resource`/`description`/`mimeType` live at the top level, not per-entry
 *      (the schema requires them on each entry).
 * It also advertises a non-standard `"upto"` (Permit2) scheme entry, which the
 * schema's `scheme: enum(["exact"])` rejects.
 *
 * This wrapper rewrites the 402 body into the shape x402-fetch can parse: keep
 * only the `exact` (EIP-3009) entry and fill the canonical fields. We preserve
 * the top-level `x402Version` (2) untouched — wrapFetchWithPayment passes it
 * straight into the signed payload, so Surplus still receives the v2 payment it
 * expects. The on-chain target (USDC on Base 8453) is unchanged, so settlement
 * is unaffected.
 */
export function normalizeSurplus402(baseFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await baseFetch(input, init);
    if (res.status !== 402) return res;
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      const top = (parsed.resource ?? {}) as {
        url?: string;
        description?: string;
        mimeType?: string;
      };
      const accepts: unknown[] = Array.isArray(parsed.accepts) ? parsed.accepts : [];

      const canonical = accepts
        .filter((a): a is Record<string, unknown> => {
          return !!a && typeof a === "object" && (a as { scheme?: string }).scheme === "exact";
        })
        .map((a) => ({
          scheme: "exact",
          network: CAIP_TO_X402_NETWORK[a.network as string] ?? (a.network as string),
          maxAmountRequired: String(a.maxAmountRequired ?? a.amount ?? "0"),
          resource: (a.resource as string) ?? top.url ?? "",
          description: (a.description as string) ?? top.description ?? "",
          mimeType: (a.mimeType as string) ?? top.mimeType ?? "application/json",
          payTo: a.payTo,
          maxTimeoutSeconds: a.maxTimeoutSeconds ?? 120,
          asset: a.asset,
          ...(a.extra ? { extra: a.extra } : {}),
          ...(a.outputSchema ? { outputSchema: a.outputSchema } : {}),
        }));

      const headers = new Headers(res.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(JSON.stringify({ ...parsed, accepts: canonical }), {
        status: 402,
        statusText: res.statusText,
        headers,
      });
    } catch {
      return new Response(text, {
        status: 402,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
  }) as unknown as typeof fetch;
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

  // Strict exact-id matching — see the note in hyperbolic.ts. Surplus actually
  // serves 177 models; we only advertise the ids we've verified settle.
  const supports = (model: string): boolean => SUPPORTED_IDS.has(model);

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
      activeFetch = wrapFetchWithPayment(
        normalizeSurplus402(globalThis.fetch),
        signer,
        maxValue,
      );
    }

    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
    });

    // Paid fetch with safe retry: concurrent terminals share one wallet, so some
    // settlements collide and the facilitator returns a pre-settlement 402
    // verification failure. fetchWithX402Retry re-signs (fresh nonce) with
    // jittered backoff — only for that provably-uncharged case. A fresh
    // X-Request-ID per attempt keeps Surplus from de-duping the retry.
    const attempt = await fetchWithX402Retry(() =>
      activeFetch(chatUrl, {
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
        error: `Surplus HTTP ${attempt.status ?? 0}: ${attempt.errorText ?? "request failed"}`,
      };
      return;
    }
    const response = attempt.response;

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
    // NOTE: Surplus settles on-chain (verified: a call debits the flat fee from
    // the wallet's USDC balance) but, unlike Hyperbolic, does NOT return an
    // `X-PAYMENT-RESPONSE` receipt header — it only lists it in CORS expose
    // headers. So `settlementTxHash` is typically undefined for Surplus and the
    // spend feed shows no basescan link for these calls. decodeReceipt tolerates
    // the missing header (returns {}).
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
