import type { SpendEvent } from "@/lib/types";

const LOG_FILE = "./.billz/spend.jsonl";

/**
 * Structured per-call logger.
 *
 * - Emits a single JSON line to stdout for log aggregators.
 * - Best-effort appends to `./.billz/spend.jsonl` for offline replay / retraining.
 *   Errors are silently swallowed — serverless FS may be read-only.
 */
export function logSpend(e: SpendEvent): void {
  // Structured console log — all observability fields from billz_prd.md §6.
  const line = JSON.stringify({
    level: "info",
    event: "spend",
    ts: e.ts,
    traceId: e.traceId,
    sessionId: e.sessionId,
    provider: e.provider,
    model: e.model,
    reason: e.reason,
    usdcCharged: e.usdcCharged,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    latencyMs: e.latencyMs,
    paymentMode: e.paymentMode,
    settlementTxHash: e.settlementTxHash,
    cacheHit: e.cacheHit,
    sessionSpent: e.sessionSpent,
    sessionBudget: e.sessionBudget,
  });
  console.log(line);

  // Fire-and-forget JSONL append — never block the request.
  appendToFile(line).catch(() => {
    // intentionally swallowed — read-only FS in serverless is expected.
  });
}

/**
 * Structured log for a provider that failed a call (and was skipped by failover).
 * Failed calls are never charged, but they must be observable — a wave of these
 * usually means an empty wallet, a broken provider endpoint, or a price over the
 * per-call cap, not a code bug.
 */
export function logProviderError(info: {
  traceId: string;
  sessionId: string;
  provider: string;
  model: string;
  error: string;
  latencyMs: number;
}): void {
  console.warn(
    JSON.stringify({ level: "warn", event: "provider_error", ts: Date.now(), ...info }),
  );
}

async function appendToFile(line: string): Promise<void> {
  const { mkdir, appendFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(LOG_FILE), { recursive: true });
  await appendFile(LOG_FILE, line + "\n", "utf8");
}
