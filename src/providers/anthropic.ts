/**
 * Anthropic (Claude) provider adapter — credit-balance model, official SDK.
 *
 * ─── PAYMENT MODEL ────────────────────────────────────────────────────────────
 * Anthropic is NOT x402 / pay-per-call on-chain. Inference is billed against a
 * pre-funded organization account, authenticated with `ANTHROPIC_API_KEY`. That
 * makes it a `credit-balance` provider (same payment class as Venice's Bearer
 * path) — there is no per-call USDC settlement and no `settlementTxHash`. The
 * USDC figure we report is the *list price* of the call, computed from the
 * model's published per-token rates × the usage the API returns, so the spend
 * feed and the quality-per-dollar leaderboard stay comparable across providers.
 *
 * GATING: `getProviders` only adds this adapter when `ANTHROPIC_API_KEY` is set,
 * so without a key Claude is absent from routing and the model list entirely —
 * it never errors into failover.
 *
 * SDK: uses the official `@anthropic-ai/sdk` Messages streaming API (loaded via
 * dynamic import so it stays out of the bundle in mock mode and on key-less
 * deployments). We do NOT use an OpenAI-compatible shim.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type AnthropicSDK from "@anthropic-ai/sdk";
import type {
  AppConfig,
  ChatMessage,
  CompletionResult,
  ModelInfo,
  ModelTag,
  PricePrior,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "@/lib/types";

// ── Price table (USD per 1M tokens, input / output) ──────────────────────────
// Source: platform.claude.com pricing (claude-api skill, cached 2026-06-04).
// IDs are the exact model strings — no date suffixes.
// ─────────────────────────────────────────────────────────────────────────────

interface AnthropicModelEntry extends ModelInfo {
  id: string;
  inputPricePerM: number;
  outputPricePerM: number;
  tags: ModelTag[];
}

const MODELS: AnthropicModelEntry[] = [
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    inputPricePerM: 1.0,
    outputPricePerM: 5.0,
    contextTokens: 200_000,
    tags: ["chat", "fast", "cheap"],
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    inputPricePerM: 3.0,
    outputPricePerM: 15.0,
    contextTokens: 1_000_000,
    tags: ["chat", "code"],
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    inputPricePerM: 5.0,
    outputPricePerM: 25.0,
    contextTokens: 1_000_000,
    tags: ["chat", "code", "reasoning"],
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    inputPricePerM: 5.0,
    outputPricePerM: 25.0,
    contextTokens: 1_000_000,
    tags: ["chat", "code", "reasoning"],
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    inputPricePerM: 10.0,
    outputPricePerM: 50.0,
    contextTokens: 1_000_000,
    tags: ["reasoning", "code", "chat"],
  },
];

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

/**
 * Models that still accept sampling parameters (`temperature`). On Opus 4.7/4.8
 * and Fable 5 the sampling params were removed and sending `temperature` returns
 * a 400 — so we only forward it for the models below. (Thinking is left off for
 * every model: omitting the `thinking` param is "off" on the Opus family and the
 * only valid setting on Fable 5, which always thinks.)
 */
const SAMPLING_MODELS = new Set<string>([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
]);

/** Default output cap. Streaming, but kept modest so a single call stays within
 *  the per-call USD budget; callers can raise it via `max_tokens`. */
const DEFAULT_MAX_TOKENS = 4096;

/** Rough token estimate (~1.3 tokens per whitespace-separated word). */
function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Split OpenAI-style messages into Anthropic's shape: a single `system` string
 * (all system turns concatenated) plus a user/assistant message list. Anything
 * that isn't an assistant turn (incl. `tool`) maps to `user`.
 */
function splitMessages(messages: ChatMessage[]): {
  system: string;
  convo: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const convo = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    }));
  // Anthropic requires a non-empty message list whose first turn is `user`.
  if (convo.length === 0) convo.push({ role: "user", content: system || "Hello" });
  return { system, convo };
}

// ── Injectable SDK surface (for tests) ────────────────────────────────────────
// Structural subset of `@anthropic-ai/sdk` we depend on, so tests can inject a
// fake client without the network or a real key.

type AnthropicStreamEvent = {
  type?: string;
  delta?: { type?: string; text?: string };
};

export interface AnthropicMessageStream extends AsyncIterable<AnthropicStreamEvent> {
  finalMessage(): Promise<{
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
}

export interface AnthropicClientLike {
  messages: {
    stream(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AnthropicMessageStream;
  };
}

export interface AnthropicDeps {
  /** Inject a fake client (tests). When absent, a real SDK client is built lazily. */
  client?: AnthropicClientLike;
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createAnthropicAdapter(
  cfg: AppConfig,
  deps?: AnthropicDeps,
): ProviderAdapter {
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

  /** Open a streaming Messages request via the injected or a real SDK client. */
  async function openStream(
    params: AnthropicSDK.MessageStreamParams,
    signal?: AbortSignal,
  ): Promise<AnthropicMessageStream> {
    if (deps?.client) return deps.client.messages.stream(params, { signal });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({
      apiKey,
      ...(cfg.anthropic?.baseUrl ? { baseURL: cfg.anthropic.baseUrl } : {}),
    });
    return client.messages.stream(params, {
      signal,
    }) as unknown as AnthropicMessageStream;
  }

  async function* stream(
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const start = Date.now();
    const model = req.model;
    const price = MODEL_MAP.get(model);

    const { system, convo } = splitMessages(req.messages);

    const params: AnthropicSDK.MessageStreamParams = {
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: convo,
      ...(system ? { system } : {}),
      ...(SAMPLING_MODELS.has(model) && req.temperature != null
        ? { temperature: req.temperature }
        : {}),
    };

    let mstream: AnthropicMessageStream;
    try {
      mstream = await openStream(params, req.signal);
    } catch (err) {
      yield { type: "error", error: `Anthropic: ${errMsg(err)}` };
      return;
    }

    let text = "";
    try {
      for await (const ev of mstream) {
        if (
          ev.type === "content_block_delta" &&
          ev.delta?.type === "text_delta" &&
          ev.delta.text
        ) {
          text += ev.delta.text;
          yield { type: "delta", content: ev.delta.text };
        }
      }
    } catch (err) {
      yield { type: "error", error: `Anthropic stream error: ${errMsg(err)}` };
      return;
    }

    // Authoritative usage from the SDK; fall back to estimates if absent.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      const final = await mstream.finalMessage();
      inputTokens = final.usage?.input_tokens;
      outputTokens = final.usage?.output_tokens;
    } catch {
      // Usage unavailable — fall through to approximations.
    }

    const inToks =
      inputTokens ?? approxTokens(req.messages.map((m) => m.content).join(" "));
    const outToks = outputTokens ?? approxTokens(text);
    const usdcCharged = price
      ? (inToks / 1e6) * price.inputPricePerM + (outToks / 1e6) * price.outputPricePerM
      : 0;

    const result: CompletionResult = {
      provider: "anthropic",
      model,
      text,
      inputTokens: inToks,
      outputTokens: outToks,
      usdcCharged: Number(usdcCharged.toFixed(8)),
      paymentMode: "credit-balance",
      // No per-call on-chain tx for the credit-balance model.
      settlementTxHash: undefined,
      latencyMs: Date.now() - start,
    };

    yield { type: "done", result };
  }

  return {
    id: "anthropic",
    displayName: "Anthropic (Claude)",
    models,
    priceFor,
    supports,
    stream,
  };
}
