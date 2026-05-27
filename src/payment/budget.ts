import type { BudgetStatus } from "@/lib/types";
import { getConfig } from "@/lib/config";

/**
 * Per-session spend cap (Stage 0: hard $5 default per session).
 *
 * Process-local, on `globalThis` to survive HMR. Stage 2 moves this to a shared
 * store and to per-user (not just per-session) limits.
 */

const g = globalThis as unknown as { __billzBudget?: Map<string, number> };

function store(): Map<string, number> {
  if (!g.__billzBudget) g.__billzBudget = new Map();
  return g.__billzBudget;
}

export function getBudgetStatus(sessionId: string): BudgetStatus {
  const budget = getConfig().sessionBudgetUsd;
  const spent = store().get(sessionId) ?? 0;
  return {
    sessionId,
    spent,
    budget,
    remaining: Math.max(0, budget - spent),
    exceeded: spent >= budget,
  };
}

/** Whether a prospective charge fits within the remaining session budget. */
export function canSpend(sessionId: string, amountUsd: number): boolean {
  return amountUsd <= getBudgetStatus(sessionId).remaining;
}

/** Record an actual charge and return the updated status. */
export function recordSpend(sessionId: string, amountUsd: number): BudgetStatus {
  const s = store();
  s.set(sessionId, (s.get(sessionId) ?? 0) + Math.max(0, amountUsd));
  return getBudgetStatus(sessionId);
}

export function resetSession(sessionId: string): void {
  store().delete(sessionId);
}
