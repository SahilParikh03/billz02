/**
 * OpenRouter provider adapter — credit-balance model, OpenAI-compatible.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * OpenRouter is an aggregator that resells Claude (and many other models) behind
 * a single OpenAI-compatible endpoint. We add it as a second route to Claude for
 * users who can't fund an Anthropic account directly — OpenRouter accepts card
 * *and* crypto top-ups. It passes Anthropic's list price through at cost (its fee
 * is taken on credit top-ups, not per call), so the per-call `usdcCharged` here
 * matches the native `anthropic` adapter and stays comparable on the spend feed.
 *
 * ─── WHY IT'S A SEPARATE ADAPTER (not ANTHROPIC_BASE_URL) ─────────────────────
 * The `anthropic` adapter speaks Anthropic's native Messages API via the official
 * SDK. OpenRouter only exposes the OpenAI chat-completions shape, so it can't be
 * reached by pointing the Anthropic SDK at it — this adapter mirrors the Venice
 * adapter (OpenAI SSE) instead, with Claude model slugs as OpenRouter spells them
 * (`anthropic/claude-…`, slugs/pricing verified live 2026-06-11).
 *
 * GATING: `getProviders` only adds OpenRouter when `OPENROUTER_API_KEY` is set, so
 * without a key it's absent from routing and the model list — it never 401s into
 * failover. paymentMode is always "credit-balance"; no per-call on-chain tx.
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
// Source: openrouter.ai/api/v1/models, verified 2026-06-11. Prices equal
// Anthropic list price (OpenRouter passes model cost through at par).
// ─────────────────────────────────────────────────────────────────────────────

interface OpenRouterModelEntry extends ModelInfo {
  id: string;
  inputPricePerM: number;
  outputPricePerM: number;
  tags: ModelTag[];
}

const MODELS: OpenRouterModelEntry[] = [
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5 (via OpenRouter)",
    inputPricePerM: 1.0,
    outputPricePerM: 5.0,
    contextTokens: 200_000,
    tags: ["chat", "fast", "cheap"],
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6 (via OpenRouter)",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    contextTokens: 1_000_000,
    tags: ["chat", "code"],
  },
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8 (via OpenRouter)",
    inputPricePerM: 5.0,
    outputPricePerM: 25.0,
    contextTokens: 1_000_000,
    tags: ["chat", "code", "reasoning"],
  },
  {
    id: "anthropic/claude-opus-4.7",
    label: "Claude Opus 4.7 (via OpenRouter)",
    inputPricePerM: 5.0,
    outputPricePerM: 25.0,
    contextTokens: 1_000_000,
    tags: ["chat", "code", "reasoning"],
  },
  {
    id: "anthropic/claude-fable-5",
    label: "Claude Fable 5 (via OpenRouter)",
    inputPricePerM: 10.0,
    outputPricePerM: 50.0,
    contextTokens: 1_000_000,
    tags: ["reasoning", "code", "chat"],
  },
];

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

/**
 * Models that accept sampling params. Opus 4.7/4.8 and Fable 5 reject
 * `temperature` upstream (400), so we forward it only for Haiku/Sonnet — mirrors
 * the gating in the native `anthropic` adapter.
 */
const SAMPLING_MODELS = new Set<string>([
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
]);

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

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
          // Malformed chunk (or an OpenRouter `: comment` keep-alive) — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export interface OpenRouterDeps {
  fetchImpl?: typeof fetch;
}

export function createOpenRouterAdapter(
  cfg: AppConfig,
  deps?: OpenRouterDeps,
): ProviderAdapter {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const baseUrl = cfg.openrouter?.baseUrl || DEFAULT_BASE_URL;

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

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      yield { type: "error", error: "OpenRouter: OPENROUTER_API_KEY is not set" };
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // Optional attribution headers OpenRouter uses for its leaderboards.
      "HTTP-Referer": "https://beamr.app",
      "X-Title": "BEAMR",
    };

    const body = JSON.stringify({
      model,
      messages: req.messages,
      stream: true,
      // Ask OpenRouter to emit a usage block on the final SSE chunk.
      stream_options: { include_usage: true },
      // Forward temperature only for models that accept sampling params.
      ...(req.temperature != null && SAMPLING_MODELS.has(model)
        ? { temperature: req.temperature }
        : {}),
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
    });

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", error: `OpenRouter fetch failed: ${String(err)}` };
      return;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "(no body)");
      yield {
        type: "error",
        error: `OpenRouter HTTP ${response.status}: ${errText}`,
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "OpenRouter: empty response body" };
      return;
    }

    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      for await (const chunk of parseOpenAiSse(response.body)) {
        // Surface upstream errors delivered inside the stream body.
        const errObj = chunk.error as { message?: string } | undefined;
        if (errObj) {
          yield {
            type: "error",
            error: `OpenRouter: ${errObj.message ?? "stream error"}`,
          };
          return;
        }

        const usage = chunk.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        if (usage) {
          if (usage.prompt_tokens != null) inputTokens = usage.prompt_tokens;
          if (usage.completion_tokens != null)
            outputTokens = usage.completion_tokens;
        }

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
      yield { type: "error", error: `OpenRouter stream error: ${String(err)}` };
      return;
    }

    // Compute charge from price priors × token counts (approx when usage absent).
    const inToks =
      inputTokens ?? approxTokens(req.messages.map((m) => m.content).join(" "));
    const outToks = outputTokens ?? approxTokens(text);
    const usdcCharged = price
      ? (inToks / 1e6) * price.inputPricePerM +
        (outToks / 1e6) * price.outputPricePerM
      : 0;

    const result: CompletionResult = {
      provider: "openrouter",
      model,
      text,
      inputTokens: inToks,
      outputTokens: outToks,
      usdcCharged: Number(usdcCharged.toFixed(8)),
      paymentMode: "credit-balance",
      // No per-call on-chain tx for the OpenRouter credit-balance model.
      settlementTxHash: undefined,
      latencyMs: Date.now() - start,
    };

    yield { type: "done", result };
  }

  return {
    id: "openrouter",
    displayName: "OpenRouter",
    models,
    priceFor,
    supports,
    stream,
  };
}
