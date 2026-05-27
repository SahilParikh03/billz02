import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getBudgetStatus,
  getUserBudgetStatus,
  canSpend,
  recordSpend,
  resetSession,
} from "./budget";
import { resetStore } from "@/lib/store";

describe("session budget", () => {
  const sid = "test-session";
  beforeEach(() => resetStore());

  it("starts at zero spent with the default $5 cap", async () => {
    const s = await getBudgetStatus(sid);
    expect(s.spent).toBe(0);
    expect(s.budget).toBe(5);
    expect(s.remaining).toBe(5);
    expect(s.exceeded).toBe(false);
  });

  it("records spend and decrements remaining", async () => {
    await recordSpend(sid, 1.5);
    const s = await getBudgetStatus(sid);
    expect(s.spent).toBeCloseTo(1.5);
    expect(s.remaining).toBeCloseTo(3.5);
  });

  it("flags exceeded and blocks further spend at the cap", async () => {
    await recordSpend(sid, 5);
    expect((await getBudgetStatus(sid)).exceeded).toBe(true);
    expect(await canSpend(sid, 0.01)).toBe(false);
  });

  it("canSpend respects remaining headroom", async () => {
    await recordSpend(sid, 4.5);
    expect(await canSpend(sid, 0.5)).toBe(true);
    expect(await canSpend(sid, 0.51)).toBe(false);
  });

  it("resetSession clears the session", async () => {
    await recordSpend(sid, 2);
    await resetSession(sid);
    expect((await getBudgetStatus(sid)).spent).toBe(0);
  });
});

describe("per-user daily budget", () => {
  const uid = "user-1";
  const sid = "sess-x";

  beforeEach(() => {
    resetStore();
    process.env.BILLZ_USER_DAILY_BUDGET_USD = "1";
  });
  afterEach(() => {
    delete process.env.BILLZ_USER_DAILY_BUDGET_USD;
  });

  it("is disabled (budget 0) when the cap is unset", async () => {
    delete process.env.BILLZ_USER_DAILY_BUDGET_USD;
    const u = await getUserBudgetStatus(uid);
    expect(u.budget).toBe(0);
    // a charge within the session cap is allowed; the disabled user cap never blocks
    expect(await canSpend(sid, 0.5, uid)).toBe(true);
  });

  it("enforces the per-user daily cap independently of the session", async () => {
    // session has plenty ($5 cap), but the user/day cap is $1
    await recordSpend(sid, 0.8, uid);
    expect(await canSpend(sid, 0.3, uid)).toBe(false); // would exceed user/day $1
    expect(await canSpend(sid, 0.15, uid)).toBe(true); // fits the remaining ~$0.20
  });

  it("tracks user spend across different sessions", async () => {
    await recordSpend("sess-a", 0.6, uid);
    await recordSpend("sess-b", 0.6, uid);
    const u = await getUserBudgetStatus(uid);
    expect(u.spent).toBeCloseTo(1.2);
    expect(u.exceeded).toBe(true);
  });
});
