import type { FeedbackRating, RoutingContext } from "./types";
import { recordVote } from "./quality";

/**
 * Bridges a request to its later thumbs-up/down.
 *
 * On each completed call the pipeline calls {@link captureContext} (traceId →
 * what was routed). When the user votes, {@link submitFeedback} looks the context
 * up, updates the learned quality priors, and appends a labeled row to a JSONL
 * training log (the durable preference dataset).
 */

const CTX_TTL_MS = 60 * 60 * 1000;
const MAX_CTX = 5000;

const g = globalThis as unknown as { __billzCtx?: Map<string, RoutingContext> };
function ctxMap(): Map<string, RoutingContext> {
  if (!g.__billzCtx) g.__billzCtx = new Map();
  return g.__billzCtx;
}

export function captureContext(ctx: RoutingContext): void {
  const m = ctxMap();
  m.set(ctx.traceId, ctx);
  if (m.size > MAX_CTX) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

export function getContext(traceId: string): RoutingContext | undefined {
  const c = ctxMap().get(traceId);
  if (!c) return undefined;
  if (Date.now() - c.ts > CTX_TTL_MS) {
    ctxMap().delete(traceId);
    return undefined;
  }
  return c;
}

export interface FeedbackResult {
  ok: boolean;
  reason?: string;
}

export async function submitFeedback(
  traceId: string,
  rating: FeedbackRating,
): Promise<FeedbackResult> {
  const ctx = getContext(traceId);
  if (!ctx) return { ok: false, reason: "unknown or expired traceId" };

  recordVote(ctx.taskClass, ctx.provider, ctx.model, rating === "up");
  await appendFeedbackLog({
    traceId,
    taskClass: ctx.taskClass,
    provider: ctx.provider,
    model: ctx.model,
    usdcCharged: ctx.usdcCharged,
    rating,
    ts: Date.now(),
  });
  return { ok: true };
}

async function appendFeedbackLog(row: Record<string, unknown>): Promise<void> {
  try {
    const { mkdir, appendFile } = await import("node:fs/promises");
    await mkdir(".billz", { recursive: true });
    await appendFile(".billz/feedback.jsonl", JSON.stringify(row) + "\n");
  } catch {
    // best-effort: serverless FS may be read-only
  }
}

export function resetFeedback(): void {
  g.__billzCtx = undefined;
}
