import { describe, it, expect, beforeEach } from "vitest";
import { getBudgetStatus, canSpend, recordSpend, resetSession } from "./budget";

describe("budget", () => {
  const sid = "test-session";
  beforeEach(() => resetSession(sid));

  it("starts at zero spent with the default $5 cap", () => {
    const s = getBudgetStatus(sid);
    expect(s.spent).toBe(0);
    expect(s.budget).toBe(5);
    expect(s.remaining).toBe(5);
    expect(s.exceeded).toBe(false);
  });

  it("records spend and decrements remaining", () => {
    recordSpend(sid, 1.5);
    const s = getBudgetStatus(sid);
    expect(s.spent).toBeCloseTo(1.5);
    expect(s.remaining).toBeCloseTo(3.5);
  });

  it("flags exceeded and blocks further spend at the cap", () => {
    recordSpend(sid, 5);
    expect(getBudgetStatus(sid).exceeded).toBe(true);
    expect(canSpend(sid, 0.01)).toBe(false);
  });

  it("canSpend respects remaining headroom", () => {
    recordSpend(sid, 4.5);
    expect(canSpend(sid, 0.5)).toBe(true);
    expect(canSpend(sid, 0.51)).toBe(false);
  });
});
