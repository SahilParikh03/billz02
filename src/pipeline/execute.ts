import type {
  AppConfig,
  CacheLookup,
  ChatCompletionRequest,
  CompletionResult,
  ProviderId,
  SpendEvent,
  StreamEvent,
} from "@/lib/types";
import { getBudgetStatus, canSpend, recordSpend } from "@/payment/budget";
import { publishSpend } from "@/lib/events";
import { getProvider, getProviders } from "@/providers/index";
import { route } from "@/policy/select";
import { captureContext } from "@/lib/feedback";
import { recordCost } from "@/lib/quality";
import { getCache } from "./cache";
import { logSpend } from "./log";

const UPFRONT_ESTIMATE_USD = 0.0001;

interface ExecOpts {
  sessionId: string;
  traceId: string;
  signal?: AbortSignal;
  /** User identity for per-user daily caps; defaults to sessionId. */
  userId?: string;
  /** Per-request policy override (X-Billz-Policy header). */
  policyMode?: string | null;
}

/**
 * Execute one chat completion end-to-end:
 *  0. Semantic cache lookup — a hit is served free, bypassing routing AND budget.
 *  1. Route (classify → strong/weak cascade → cheapest in tier).
 *  2. Pre-check the session budget.
 *  3. Stream from the chosen adapter, forwarding deltas; failover on error.
 *  4. On done: record spend, publish a SpendEvent, store the result in the cache.
 */
export async function* executeChat(
  cfg: AppConfig,
  req: ChatCompletionRequest,
  opts: ExecOpts,
): AsyncGenerator<StreamEvent, void, unknown> {
  const { sessionId, traceId, signal, userId = sessionId, policyMode } = opts;

  // ── 0. Cache lookup ───────────────────────────────────────────────────────────
  const cache = cfg.cache.enabled ? getCache(cfg) : null;
  if (cache) {
    const hit = await cache.lookup(req.messages);
    if (hit.hit) {
      yield* serveFromCache(hit, opts);
      return;
    }
  }

  // ── 1. Route ──────────────────────────────────────────────────────────────────
  const decision = route(cfg, req, { policyMode });

  // ── 2. Budget pre-check ───────────────────────────────────────────────────────
  const initialStatus = await getBudgetStatus(sessionId);
  if (initialStatus.exceeded || !(await canSpend(sessionId, UPFRONT_ESTIMATE_USD, userId))) {
    yield { type: "error", error: "session budget exceeded" };
    return;
  }

  // ── 3. Ordered failover list (chosen provider first) ──────────────────────────
  const allActive = getProviders(cfg);
  const ordered: ProviderId[] = [
    decision.provider,
    ...allActive.map((p) => p.id).filter((id) => id !== decision.provider),
  ];

  // ── 4. Try each provider in turn ──────────────────────────────────────────────
  for (const providerId of ordered) {
    const adapter = getProvider(cfg, providerId);
    if (!adapter) continue;

    const model =
      providerId === decision.provider
        ? decision.model
        : adapter.models()[0]?.id ?? req.model ?? "";

    const providerReq = {
      model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.max_tokens,
      signal,
    };

    const start = Date.now();

    try {
      for await (const event of adapter.stream(providerReq)) {
        if (event.type === "delta") {
          yield event;
        } else if (event.type === "done") {
          const latencyMs = Date.now() - start;
          const result = event.result;

          const status = await recordSpend(sessionId, result.usdcCharged, userId);

          const spendEvent: SpendEvent = {
            ts: Date.now(),
            traceId,
            sessionId,
            provider: result.provider,
            model: result.model,
            reason: decision.reason,
            usdcCharged: result.usdcCharged,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs: result.latencyMs ?? latencyMs,
            paymentMode: result.paymentMode,
            settlementTxHash: result.settlementTxHash,
            cacheHit: false,
            sessionSpent: status.spent,
            sessionBudget: status.budget,
          };

          publishSpend(spendEvent);
          logSpend(spendEvent);

          // Stage 3: capture routing context + cost so a later thumbs-up/down
          // becomes a labeled example that tunes future routing.
          if (decision.taskClass) {
            captureContext({
              traceId,
              taskClass: decision.taskClass,
              provider: result.provider,
              model: result.model,
              usdcCharged: result.usdcCharged,
              ts: Date.now(),
            });
          }
          recordCost(result.provider, result.model, result.usdcCharged);

          // Populate the cache for future (semantically) identical requests.
          if (cache) await cache.store(req.messages, result);

          yield event;
          return;
        } else if (event.type === "error") {
          break; // this provider failed — try the next one (not charged)
        }
      }
    } catch {
      // adapter/network exception — treat as a provider failure, try next
    }
  }

  yield { type: "error", error: "all providers failed" };
}

/** Stream a cached completion back to the client — free, no budget impact. */
async function* serveFromCache(
  hit: Extract<CacheLookup, { hit: true }>,
  opts: ExecOpts,
): AsyncGenerator<StreamEvent, void, unknown> {
  const { sessionId, traceId, signal } = opts;
  const start = Date.now();
  const cached = hit.result;

  let text = "";
  for (const word of cached.text.split(" ")) {
    if (signal?.aborted) break;
    const chunk = (text ? " " : "") + word;
    text += chunk;
    yield { type: "delta", content: chunk };
  }

  const result: CompletionResult = {
    ...cached,
    text,
    usdcCharged: 0,
    latencyMs: Date.now() - start,
  };

  // A cache hit costs nothing, so the budget is unchanged — just report status.
  const status = await getBudgetStatus(sessionId);
  const spendEvent: SpendEvent = {
    ts: Date.now(),
    traceId,
    sessionId,
    provider: cached.provider,
    model: cached.model,
    reason: `cache hit (${hit.kind}, sim ${hit.similarity.toFixed(2)}) — served free`,
    usdcCharged: 0,
    inputTokens: cached.inputTokens,
    outputTokens: cached.outputTokens,
    latencyMs: result.latencyMs,
    paymentMode: cached.paymentMode,
    cacheHit: true,
    sessionSpent: status.spent,
    sessionBudget: status.budget,
  };

  publishSpend(spendEvent);
  logSpend(spendEvent);

  yield { type: "done", result };
}
