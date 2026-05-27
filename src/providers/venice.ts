/**
 * Venice provider adapter — credit-balance model, OpenAI-compatible.
 *
 * ─── PAYMENT MODEL (honest summary) ───────────────────────────────────────────
 * Venice funds an *internal credit balance* via a separate top-up step, not via
 * per-inference x402. The PRODUCTION path is:
 *   1. POST ${baseUrl}/x402/top-up carrying an `X-402-Payment` header (a signed
 *      USDC-on-Base EIP-3009 authorization built with `x402-fetch`).
 *   2. All inference requests authenticate with an `X-Sign-In-With-X` (SIWE)
 *      header — a non-standard Venice extension of the canonical x402 scheme.
 *      (Source: venice.ai/blog/venice-now-supports-x402; billz_prd.md §2)
 *
 * TODO (Stage 1): implement the full top-up + SIWE handshake.
 *   - top-up:  POST `${cfg.venice.baseUrl}/x402/top-up`
 *              headers: { 'X-402-Payment': <signed USDC auth from getSigner()> }
 *   - inference: add `X-Sign-In-With-X: <session-scoped SIWE message + signature>`
 *                to every chat/completions request.
 *
 * STAGE 0 PATH (what we do now):
 *   - If VENICE_API_KEY is set in the environment, use it as a Bearer token.
 *     This covers the simplest live path for developers who already have a key.
 *   - If VENICE_API_KEY is absent, requests are sent without auth (the server
 *     will likely 401 — acceptable for Stage 0 testnet where we focus on
 *     Hyperbolic for the real x402 path and Venice for the structure).
 *
 * paymentMode is always "credit-balance" — no per-call on-chain tx.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  AppConfig,
  ModelInfo,
  ModelTag,
  PricePrior,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  CompletionResult,
} from "@/lib/types";

// ── Price table (USD per 1M tokens, input / output) ──────────────────────────
// Source: docs.venice.ai/overview/pricing as cited in billz_prd.md §2
// ─────────────────────────────────────────────────────────────────────────────

interface VeniceModelEntry extends ModelInfo {
  id: string;
  inputPricePerM: number;
  outputPricePerM: number;
  tags: ModelTag[];
}

const MODELS: VeniceModelEntry[] = [
  {
    id: "llama-3.3-70b",
    label: "Llama 3.3 70B",
    inputPricePerM: 0.70,
    outputPricePerM: 2.80,
    contextTokens: 128_000,
    tags: ["chat", "fast"],
  },
  {
    id: "kimi-k2-6",
    label: "Kimi K2-6",
    inputPricePerM: 0.85,
    outputPricePerM: 4.66,
    contextTokens: 256_000,
    tags: ["reasoning", "chat"],
  },
  {
    id: "qwen3-235b-a22b-instruct-2507",
    label: "Qwen3 235B Instruct",
    inputPricePerM: 0.15,
    outputPricePerM: 0.75,
    contextTokens: 128_000,
    tags: ["chat", "cheap"],
  },
  {
    id: "qwen3-235b-a22b-thinking-2507",
    label: "Qwen3 235B Thinking",
    inputPricePerM: 0.45,
    outputPricePerM: 3.50,
    contextTokens: 128_000,
    tags: ["reasoning"],
  },
  {
    id: "deepseek-v3.2",
    label: "DeepSeek V3.2",
    inputPricePerM: 0.33,
    outputPricePerM: 0.48,
    contextTokens: 64_000,
    tags: ["chat", "code", "cheap"],
  },
  {
    id: "mistral-small-3-2-24b-instruct",
    label: "Mistral Small 3.2 24B",
    inputPricePerM: 0.09,
    outputPricePerM: 0.25,
    contextTokens: 32_000,
    tags: ["fast", "cheap", "chat"],
  },
  {
    id: "venice-uncensored-1-2",
    label: "Venice Uncensored 1.2",
    inputPricePerM: 0.20,
    outputPricePerM: 0.90,
    contextTokens: 32_000,
    tags: ["uncensored", "creative", "chat"],
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5 (via Venice)",
    inputPricePerM: 3.75,
    outputPricePerM: 18.75,
    contextTokens: 200_000,
    tags: ["reasoning", "chat"],
  },
];

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

// ── SSE parsing helper ────────────────────────────────────────────────────────

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
      // Keep the last (potentially incomplete) line in the buffer
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

// ── Adapter factory ───────────────────────────────────────────────────────────

export interface VenicelDeps {
  fetchImpl?: typeof fetch;
}

export function createVeniceAdapter(
  cfg: AppConfig,
  deps?: VenicelDeps,
): ProviderAdapter {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;

  const models = (): ModelInfo[] => MODELS;

  const priceFor = (model: string): PricePrior | undefined => {
    const entry = MODEL_MAP.get(model);
    if (!entry) return undefined;
    return {
      inputPricePerM: entry.inputPricePerM,
      outputPricePerM: entry.outputPricePerM,
    };
  };

  const supports = (model: string): boolean => MODEL_MAP.has(model);

  async function* stream(
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const start = Date.now();
    const model = req.model;
    const price = MODEL_MAP.get(model);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Stage 0: simple API key auth if available
    const apiKey = process.env.VENICE_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
      model,
      messages: req.messages,
      stream: true,
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
    });

    let response: Response;
    try {
      response = await fetchImpl(`${cfg.venice.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", error: `Venice fetch failed: ${String(err)}` };
      return;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "(no body)");
      yield {
        type: "error",
        error: `Venice HTTP ${response.status}: ${errText}`,
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "Venice: empty response body" };
      return;
    }

    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      for await (const chunk of parseOpenAiSse(response.body)) {
        // Final chunk with usage
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
          finish_reason?: string;
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
      yield { type: "error", error: `Venice stream error: ${String(err)}` };
      return;
    }

    // Compute charge from price priors × token counts
    const inToks = inputTokens ?? approxTokens(req.messages.map((m) => m.content).join(" "));
    const outToks = outputTokens ?? approxTokens(text);
    const usdcCharged = price
      ? (inToks / 1e6) * price.inputPricePerM + (outToks / 1e6) * price.outputPricePerM
      : 0;

    const result: CompletionResult = {
      provider: "venice",
      model,
      text,
      inputTokens: inToks,
      outputTokens: outToks,
      usdcCharged: Number(usdcCharged.toFixed(8)),
      paymentMode: "credit-balance",
      // No per-call on-chain tx for Venice credit-balance model
      settlementTxHash: undefined,
      latencyMs: Date.now() - start,
    };

    yield { type: "done", result };
  }

  return {
    id: "venice",
    displayName: "Venice",
    models,
    priceFor,
    supports,
    stream,
  };
}
