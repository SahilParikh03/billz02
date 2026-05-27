/**
 * Welcome-credit ledger for signed-in (embedded-wallet) users.
 *
 * The consumer onboarding hook (dossier §"Unproven consumer demand"): a user
 * signs up with email → gets a CDP embedded wallet → we grant a small one-time
 * "test credit" so they can try paid inference without first acquiring USDC.
 *
 * This is the server-side accounting for that credit. It is keyed by the user's
 * wallet address and backed by the pluggable {@link getStore} (in-memory by
 * default, Redis in prod) so the balance holds across instances. Anonymous
 * (session-only) users have no credit row and keep using the per-session $5 cap;
 * credit gating applies only to wallet-identified users — see {@link isWalletUser}.
 *
 * The grant is idempotent per user: a returning user is not re-funded.
 */

import { getStore } from "./store";

const grantedKey = (userId: string) => `credit:granted:${userId}`;
const balanceKey = (userId: string) => `credit:balance:${userId}`;

export interface CreditStatus {
  userId: string;
  /** Remaining test credit in USD (never negative). */
  balance: number;
  /** Whether a welcome grant has ever been issued to this user. */
  granted: boolean;
}

/**
 * True when `userId` is an EVM wallet address (a signed-in embedded-wallet
 * user) rather than an anonymous session id. Credit gating applies only to
 * these; session-only users fall through to the per-session budget.
 */
export function isWalletUser(userId: string | undefined | null): boolean {
  return typeof userId === "string" && /^0x[0-9a-fA-F]{40}$/.test(userId);
}

/** Remaining credit balance in USD, clamped at 0. */
export async function getCreditBalance(userId: string): Promise<number> {
  const v = await getStore().get(balanceKey(userId));
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether this user has any test credit left. */
export async function hasCredit(userId: string): Promise<boolean> {
  return (await getCreditBalance(userId)) > 0;
}

/**
 * Grant the one-time welcome credit, idempotently. If the user has been granted
 * before, this is a no-op and returns their current status with `granted: true`.
 * Returns the resulting status.
 */
export async function grantWelcomeCredit(
  userId: string,
  amountUsd: number,
): Promise<CreditStatus> {
  const store = getStore();
  const already = await store.get(grantedKey(userId));
  if (already) {
    return { userId, balance: await getCreditBalance(userId), granted: true };
  }
  const amount = Math.max(0, amountUsd);
  // Mark granted first so a concurrent retry can't double-fund; then set balance.
  await store.set(grantedKey(userId), "1");
  await store.set(balanceKey(userId), String(amount));
  return { userId, balance: amount, granted: true };
}

/**
 * Deduct `amountUsd` from the user's credit balance. Returns the new balance
 * (clamped at 0). A no-op for non-positive amounts.
 */
export async function chargeCredit(
  userId: string,
  amountUsd: number,
): Promise<number> {
  const amt = Math.max(0, amountUsd);
  if (amt === 0) return getCreditBalance(userId);
  const next = await getStore().incrByFloat(balanceKey(userId), -amt);
  // Floor a negative balance back to 0 so it reads cleanly.
  if (next < 0) {
    await getStore().set(balanceKey(userId), "0");
    return 0;
  }
  return next;
}

/** Full credit status for a user. */
export async function creditStatus(userId: string): Promise<CreditStatus> {
  const [balance, granted] = await Promise.all([
    getCreditBalance(userId),
    getStore().get(grantedKey(userId)),
  ]);
  return { userId, balance, granted: Boolean(granted) };
}

/** Reset a user's credit — for tests. */
export async function resetCredit(userId: string): Promise<void> {
  await Promise.all([
    getStore().del(grantedKey(userId)),
    getStore().del(balanceKey(userId)),
  ]);
}
