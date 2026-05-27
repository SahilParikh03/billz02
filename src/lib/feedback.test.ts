import { describe, it, expect, beforeEach } from "vitest";
import {
  captureContext,
  getContext,
  submitFeedback,
  resetFeedback,
} from "./feedback";
import { learnedQuality, resetQuality } from "./quality";

describe("feedback", () => {
  beforeEach(() => {
    resetFeedback();
    resetQuality();
  });

  it("captures and retrieves routing context", () => {
    captureContext({
      traceId: "t1",
      taskClass: "code",
      provider: "hyperbolic",
      model: "deepseek-v3",
      usdcCharged: 0.001,
      ts: Date.now(),
    });
    expect(getContext("t1")?.provider).toBe("hyperbolic");
  });

  it("submitFeedback records a vote for the routed model", async () => {
    captureContext({
      traceId: "t2",
      taskClass: "reasoning",
      provider: "venice",
      model: "kimi-k2-6",
      usdcCharged: 0.002,
      ts: Date.now(),
    });
    const r = await submitFeedback("t2", "up");
    expect(r.ok).toBe(true);
    expect(learnedQuality("reasoning", "venice", "kimi-k2-6")!).toBeGreaterThan(0.5);
  });

  it("returns ok:false for an unknown traceId", async () => {
    const r = await submitFeedback("nope", "up");
    expect(r.ok).toBe(false);
  });
});
