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
import { isWalletUser, hasCredit, chargeCredit } from "@/lib/credit";
import { publishSpend } from "@/lib/events";
import { getProvider, getProviders } from "@/providers/index";
import { route } from "@/policy/select";
import { captureContext } from "@/lib/feedback";
import { recordCost } from "@/lib/quality";
import { getCache } from "./cache";
import { logSpend, logProviderError } from "./log";

const UPFRONT_ESTIMATE_USD = 0.0001;

interface ExecOpts {
  sessionId: string;
  traceId: string;
  signal?: AbortSignal;
  /** User identity for per-user daily caps; defaults to sessionId. */
  userId?: string;
  /** Per-request policy override (X-Beamr-Policy header). */
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

  // The user pins each terminal to one model. A non-empty `pinnedModel` both
  // (a) namespaces the cache so two models never share an answer, and (b) forces
  // strict routing below (serve that exact model or fail — never substitute).
  // Empty string = the `auto` router path (shared cache + cross-model failover).
  const pinnedModel = req.model && req.model !== "auto" ? req.model : "";

  // ── 0. Cache lookup ───────────────────────────────────────────────────────────
  const cache = cfg.cache.enabled ? getCache(cfg) : null;
  if (cache) {
    const hit = await cache.lookup(req.messages, pinnedModel);
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

  // Signed-in (wallet) users additionally spend from their welcome credit.
  // Anonymous session users skip this and rely on the session/daily budget.
  const walletUser = isWalletUser(userId);
  if (walletUser && !(await hasCredit(userId))) {
    yield { type: "error", error: "credit exhausted" };
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

    // For a pinned model, only providers that actually serve THAT exact model
    // are eligible, and we always send that id — never silently substitute a
    // different model. Each terminal is pinned to one model by the user, so a
    // failed call must surface as an error, not as another model's answer.
    // Cross-model failover stays enabled only for the `auto` router path.
    let model: string;
    if (pinnedModel) {
      if (!adapter.supports(pinnedModel)) continue;
      model = pinnedModel;
    } else {
      model =
        providerId === decision.provider
          ? decision.model
          : adapter.models()[0]?.id ?? req.model ?? "";
    }

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

          // Deplete the signed-in user's welcome credit by the same amount.
          if (walletUser) await chargeCredit(userId, result.usdcCharged);

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

          // Populate the cache for future (semantically) identical requests,
          // under the same model namespace we looked up with.
          if (cache) await cache.store(req.messages, result, pinnedModel);

          yield event;
          return;
        } else if (event.type === "error") {
          // This provider failed — log it (not charged) and try the next one.
          logProviderError({
            traceId,
            sessionId,
            provider: providerId,
            model,
            error: event.error,
            latencyMs: Date.now() - start,
          });
          break;
        }
      }
    } catch (err) {
      // adapter/network exception — treat as a provider failure, try next
      logProviderError({
        traceId,
        sessionId,
        provider: providerId,
        model,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      });
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
