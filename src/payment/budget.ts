import type { BudgetStatus } from "@/lib/types";
import { getConfig } from "@/lib/config";
import { getStore } from "@/lib/store";

/**
 * Spend caps, backed by the pluggable {@link getStore} (in-memory by default,
 * Redis in production so the budget is enforced across serverless instances).
 *
 * Two dimensions:
 *  - per-session  (`sessionBudgetUsd`, the Stage 0 $5 cap)
 *  - per-user/day (`userDailyBudgetUsd`, Stage 2; 0 disables it)
 *
 * All functions are async because the backing store may be remote.
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const USER_DAY_TTL_MS = 26 * 60 * 60 * 1000; // outlives the UTC day it covers

const sessionKey = (id: string) => `budget:session:${id}`;
const userKey = (id: string) =>
  `budget:user:${id}:${new Date().toISOString().slice(0, 10)}`; // YYYY-MM-DD (UTC)

async function spentAt(key: string): Promise<number> {
  const v = await getStore().get(key);
  return v ? Number(v) : 0;
}

function statusFrom(id: string, spent: number, budget: number): BudgetStatus {
  return {
    sessionId: id,
    spent,
    budget,
    remaining: Math.max(0, budget - spent),
    exceeded: budget > 0 && spent >= budget,
  };
}

export async function getBudgetStatus(sessionId: string): Promise<BudgetStatus> {
  return statusFrom(
    sessionId,
    await spentAt(sessionKey(sessionId)),
    getConfig().sessionBudgetUsd,
  );
}

/** Per-user daily status. `budget` is 0 when the per-user cap is disabled. */
export async function getUserBudgetStatus(userId: string): Promise<BudgetStatus> {
  return statusFrom(
    userId,
    await spentAt(userKey(userId)),
    getConfig().userDailyBudgetUsd ?? 0,
  );
}

/** Whether a prospective charge fits both the session and (if set) the user cap. */
export async function canSpend(
  sessionId: string,
  amountUsd: number,
  userId?: string,
): Promise<boolean> {
  const session = await getBudgetStatus(sessionId);
  if (session.exceeded || amountUsd > session.remaining) return false;

  const userDaily = getConfig().userDailyBudgetUsd ?? 0;
  if (userId && userDaily > 0) {
    const user = await getUserBudgetStatus(userId);
    if (user.exceeded || amountUsd > user.remaining) return false;
  }
  return true;
}

/** Record an actual charge against the session (and user/day, if enabled). */
export async function recordSpend(
  sessionId: string,
  amountUsd: number,
  userId?: string,
): Promise<BudgetStatus> {
  const amt = Math.max(0, amountUsd);
  const store = getStore();
  const spent = await store.incrByFloat(sessionKey(sessionId), amt, SESSION_TTL_MS);

  const userDaily = getConfig().userDailyBudgetUsd ?? 0;
  if (userId && userDaily > 0) {
    await store.incrByFloat(userKey(userId), amt, USER_DAY_TTL_MS);
  }

  return statusFrom(sessionId, spent, getConfig().sessionBudgetUsd);
}

export async function resetSession(sessionId: string): Promise<void> {
  await getStore().del(sessionKey(sessionId));
}

export async function resetUser(userId: string): Promise<void> {
  await getStore().del(userKey(userId));
}
