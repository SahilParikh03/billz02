/**
 * BEAMR shared contract.
 *
 * Everything that crosses a module boundary lives here so the provider adapters,
 * the routing policy, the payment layer, the streaming pipeline, and the UI all
 * agree on the same shapes. Adding a 4th provider should mean writing one file
 * that implements {@link ProviderAdapter} — nothing here should need to change.
 */

import type { Hex } from "viem";

// ── Providers ───────────────────────────────────────────────────────────────

export type ProviderId =
  | "venice"
  | "hyperbolic"
  | "surplus"
  | "anthropic"
  | "openrouter"
  | "mock";

/**
 * How a given call was paid for.
 * - `x402-percall`   real per-call USDC settlement on-chain (Hyperbolic).
 * - `credit-balance` burned from a pre-funded provider balance (Venice, Anthropic, OpenRouter).
 * - `mock`           simulated; no wallet or network involved.
 */
export type PaymentMode = "x402-percall" | "credit-balance" | "mock";

export type ModelTag =
  | "chat"
  | "code"
  | "reasoning"
  | "creative"
  | "fast"
  | "cheap"
  | "uncensored";

/** A model offered by a provider, with optional price priors (USD per 1M tokens). */
export interface ModelInfo {
  id: string; // provider-native id, e.g. "llama-3.3-70b"
  label?: string;
  inputPricePerM?: number; // USD / 1M input tokens (undefined if dynamic/unknown)
  outputPricePerM?: number; // USD / 1M output tokens
  contextTokens?: number;
  tags?: ModelTag[];
}

export interface PricePrior {
  inputPricePerM?: number;
  outputPricePerM?: number;
}

// ── Requests / messages ───────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

/** Subset of the OpenAI chat-completions request BEAMR accepts in Stage 0. */
export interface ChatCompletionRequest {
  /** Model id, or "auto"/absent to let the router choose. */
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** Optional session id for budget tracking; also accepted via the X-Beamr-Session header. */
  session_id?: string;
}

/** Normalized input handed to a provider adapter. */
export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

// ── Results / streaming ────────────────────────────────────────────────────────

/** Usage + settlement details for one completed provider call. */
export interface CompletionResult {
  provider: ProviderId;
  model: string;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  /** USDC actually charged for this call, as a decimal USD amount. */
  usdcCharged: number;
  /** On-chain settlement tx hash, when a per-call x402 settlement occurred. */
  settlementTxHash?: string;
  paymentMode: PaymentMode;
  latencyMs: number;
}

/**
 * Tagged stream events from an adapter. An adapter yields any number of `delta`
 * events, then exactly one terminal `done` (or `error`) event.
 */
export type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; result: CompletionResult }
  | { type: "error"; error: string };

/**
 * The pluggable provider contract. One file per provider implements this.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Models this provider exposes (static priors or discovered at runtime). */
  models(): ModelInfo[];
  /** Price prior for a model id; undefined when the price is only known dynamically. */
  priceFor(model: string): PricePrior | undefined;
  /** Whether this adapter can serve the given model id. */
  supports(model: string): boolean;
  /** Execute a streaming chat completion. */
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, unknown>;
}

// ── Routing ──────────────────────────────────────────────────────────────────

/** A routing decision plus the classification that produced it. */
export interface RouteDecision {
  provider: ProviderId;
  model: string;
  /** Human-readable rationale, surfaced in the spend feed for transparency. */
  reason: string;
  /** Task class + difficulty, carried through so feedback can be labeled (Stage 3). */
  taskClass?: QueryClass;
  difficulty?: number;
}

// ── Feedback & policy (Stage 3) ────────────────────────────────────────────────

export type PolicyMode = "frugal" | "balanced" | "premium" | "uncensored";

export type FeedbackRating = "up" | "down";

/** Captured per request so a later thumbs-up/down becomes a labeled example. */
export interface RoutingContext {
  traceId: string;
  taskClass: QueryClass;
  provider: ProviderId;
  model: string;
  usdcCharged: number;
  ts: number;
}

/** One row of the quality-per-dollar leaderboard. */
export interface LeaderboardRow {
  taskClass: QueryClass;
  provider: ProviderId;
  model: string;
  up: number;
  down: number;
  winRate: number;
  avgCostUsd: number;
  qualityPerDollar: number;
  samples: number;
}

// ── Budget ───────────────────────────────────────────────────────────────────

export interface BudgetStatus {
  sessionId: string;
  spent: number; // USD spent this session
  budget: number; // USD cap
  remaining: number;
  exceeded: boolean;
}

// ── Spend feed ─────────────────────────────────────────────────────────────────

/** One charge, broadcast to the live spend feed (SSE) and the per-call log. */
export interface SpendEvent {
  ts: number; // epoch ms
  traceId: string;
  sessionId: string;
  provider: ProviderId;
  model: string;
  reason: string; // routing rationale
  usdcCharged: number; // USD decimal
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  paymentMode: PaymentMode;
  settlementTxHash?: string;
  cacheHit: boolean; // always false in Stage 0 (no semantic cache yet)
  sessionSpent: number; // cumulative session spend after this charge
  sessionBudget: number; // the cap in effect
}

// ── Classification (Stage 1) ──────────────────────────────────────────────────

export type QueryClass = "code" | "reasoning" | "creative" | "chat";

/** Output of the difficulty classifier for one request. */
export interface Classification {
  /** 0 (trivial) … 1 (hard). Drives the strong/weak cascade. */
  difficulty: number;
  taskClass: QueryClass;
  /** Estimated output length in tokens (output dominates cost on long gens). */
  expectedOutTokens: number;
  /** Interpretable feature contributions, for debugging/transparency. */
  signals?: Record<string, number>;
}

// ── Scoring (Stage 1) ───────────────────────────────────────────────────────────

export type Tier = "weak" | "strong";

export interface Candidate {
  provider: ProviderId;
  model: string;
}

export interface ScoredCandidate extends Candidate {
  /** Lower is better: estCostUsd + λ·estLatencyMs + μ·(1 − qualityPrior). */
  score: number;
  estCostUsd: number;
  qualityPrior: number; // 0..1 prior for this model on the task class
  tier: Tier;
  tags?: ModelTag[];
}

// ── Semantic cache (Stage 1) ────────────────────────────────────────────────────

/**
 * Pluggable text embedder. The default is a zero-dependency local embedder; a
 * MiniLM (`@huggingface/transformers`) backend can be swapped in behind this
 * interface via {@link EmbedderKind}.
 */
export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

/**
 * Which embedding backend the semantic cache uses.
 * - `local`  zero-dependency FNV-1a hashing embedder (offline, default).
 * - `minilm` all-MiniLM-L6-v2 via @huggingface/transformers (384-d, downloads
 *            the model on first use; the package is an optional dependency).
 */
export type EmbedderKind = "local" | "minilm";

export type CacheKind = "exact" | "semantic";

export type CacheLookup =
  | { hit: true; kind: CacheKind; similarity: number; result: CompletionResult }
  | { hit: false };

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
}

export interface SemanticCache {
  /**
   * `scope` namespaces the cache so requests pinned to different models never
   * share a cached answer (the multi-terminal compare-models UX). Empty string
   * (the default) is the shared namespace used by the `auto` router path.
   */
  lookup(messages: ChatMessage[], scope?: string): Promise<CacheLookup>;
  store(messages: ChatMessage[], result: CompletionResult, scope?: string): Promise<void>;
  stats(): CacheStats;
}

// ── Config ───────────────────────────────────────────────────────────────────

export type ProviderMode = "live" | "mock";

export interface AppConfig {
  providerMode: ProviderMode;
  sessionBudgetUsd: number;
  /** Per-user daily cap in USD; 0 (default) disables the per-user limit. */
  userDailyBudgetUsd?: number;
  /** One-time test credit (USD) granted to a new signed-in wallet user. */
  welcomeCreditUsd?: number;
  maxPaymentPerCallUsd: number;
  network: string; // "base-sepolia" | "base"
  walletPrivateKey?: Hex;
  venice: { baseUrl: string };
  hyperbolic: { url: string };
  /**
   * Anthropic (Claude) provider. Optional on the type so existing config
   * fixtures need not specify it; `getConfig()` always populates it. The API
   * key is read from `ANTHROPIC_API_KEY` in the adapter (mirrors Venice), so
   * only the optional base-URL override lives here.
   */
  anthropic?: { baseUrl?: string };
  /**
   * OpenRouter provider (OpenAI-compatible aggregator; a second route to Claude).
   * Optional on the type so existing config fixtures need not specify it;
   * `getConfig()` always populates it. The API key is read from
   * `OPENROUTER_API_KEY` in the adapter (mirrors Venice), so only the optional
   * base-URL override lives here.
   */
  openrouter?: { baseUrl?: string };
  routing: {
    /** difficulty ≥ this → strong tier, else weak tier. */
    difficultyThreshold: number;
    /** λ: weight on estimated latency (ms) in the score. 0 = ignore. */
    latencyWeight: number;
    /** μ: weight on (1 − qualityPrior) in the score. 0 = ignore. */
    qualityWeight: number;
  };
  cache: {
    enabled: boolean;
    /** cosine similarity ≥ this counts as a semantic hit. */
    simThreshold: number;
    ttlMs: number;
    maxEntries: number;
    /** Embedding backend for the semantic layer; defaults to "local". */
    embedder?: EmbedderKind;
  };
  /**
   * Seller-side x402 paywall (Phase 1): when enabled, BEAMR charges callers
   * per non-streaming completion in USDC over x402. Disabled by default, so
   * the public endpoint stays free until `BEAMR_SELL_ENABLED` is set.
   *
   * Optional on the type so existing config fixtures need not specify it;
   * `getConfig()` always populates it. Resolve via `resolveSell(cfg)`.
   */
  sell?: {
    enabled: boolean;
    /** Recipient address for settled payments (the BEAMR treasury / router). */
    payTo?: string;
    /** Flat price (USD) for a weak-tier completion. */
    priceWeakUsd: number;
    /** Flat price (USD) for a strong-tier completion. */
    priceStrongUsd: number;
    /** How long (s) a buyer's signed authorization stays valid for settlement. */
    maxTimeoutSeconds: number;
  };
  /**
   * Cost-plus pricing (Phase A). Both paid lanes charge realized/estimated
   * provider cost × {@link marginMultiplier} so every paid call recovers cost
   * plus a margin, rather than a flat per-tier price.
   *
   * Optional on the type so existing config fixtures need not specify it;
   * `getConfig()` always populates it. Resolve via `resolvePricing(cfg)`.
   */
  pricing?: {
    /** Charge `costUsd × this`. Default 1.3 (a 30% margin over cost). */
    marginMultiplier: number;
  };
}
