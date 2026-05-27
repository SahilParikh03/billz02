/**
 * BILLZ shared contract.
 *
 * Everything that crosses a module boundary lives here so the provider adapters,
 * the routing policy, the payment layer, the streaming pipeline, and the UI all
 * agree on the same shapes. Adding a 4th provider should mean writing one file
 * that implements {@link ProviderAdapter} — nothing here should need to change.
 */

import type { Hex } from "viem";

// ── Providers ───────────────────────────────────────────────────────────────

export type ProviderId = "venice" | "hyperbolic" | "surplus" | "mock";

/**
 * How a given call was paid for.
 * - `x402-percall`   real per-call USDC settlement on-chain (Hyperbolic).
 * - `credit-balance` burned from a pre-funded provider balance (Venice).
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

/** Subset of the OpenAI chat-completions request BILLZ accepts in Stage 0. */
export interface ChatCompletionRequest {
  /** Model id, or "auto"/absent to let the router choose. */
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** Optional session id for budget tracking; also accepted via the X-Billz-Session header. */
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

/** A Stage-0 routing decision (rule-based; no ML classifier yet). */
export interface RouteDecision {
  provider: ProviderId;
  model: string;
  /** Human-readable rationale, surfaced in the spend feed for transparency. */
  reason: string;
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
}

// ── Semantic cache (Stage 1) ────────────────────────────────────────────────────

/**
 * Pluggable text embedder. The default is a zero-dependency local embedder; a
 * MiniLM (`@xenova/transformers`) backend can be swapped in behind this interface.
 */
export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

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
  lookup(messages: ChatMessage[]): Promise<CacheLookup>;
  store(messages: ChatMessage[], result: CompletionResult): Promise<void>;
  stats(): CacheStats;
}

// ── Config ───────────────────────────────────────────────────────────────────

export type ProviderMode = "live" | "mock";

export interface AppConfig {
  providerMode: ProviderMode;
  sessionBudgetUsd: number;
  /** Per-user daily cap in USD; 0 (default) disables the per-user limit. */
  userDailyBudgetUsd?: number;
  maxPaymentPerCallUsd: number;
  network: string; // "base-sepolia" | "base"
  facilitatorUrl: string;
  walletPrivateKey?: Hex;
  venice: { baseUrl: string };
  hyperbolic: { url: string };
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
  };
}
