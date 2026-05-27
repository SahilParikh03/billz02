import { describe, it, expect, beforeEach } from "vitest";
import {
  recordVote,
  recordCost,
  learnedQuality,
  leaderboard,
  resetQuality,
} from "./quality";

describe("learned quality", () => {
  beforeEach(() => resetQuality());

  it("returns undefined when there are no votes", () => {
    expect(learnedQuality("chat", "venice", "m")).toBeUndefined();
  });

  it("posterior rises with upvotes and falls with downvotes", () => {
    recordVote("code", "hyperbolic", "deepseek-v3", true);
    recordVote("code", "hyperbolic", "deepseek-v3", true);
    expect(learnedQuality("code", "hyperbolic", "deepseek-v3")!).toBeCloseTo(0.75); // (2+1)/(2+2)

    recordVote("code", "venice", "x", false);
    expect(learnedQuality("code", "venice", "x")!).toBeCloseTo(1 / 3); // (0+1)/(1+2)
  });

  it("keys votes independently per task class", () => {
    recordVote("chat", "venice", "a", true);
    expect(learnedQuality("reasoning", "venice", "a")).toBeUndefined();
  });

  it("leaderboard ranks by quality-per-dollar", () => {
    recordVote("chat", "venice", "cheap", true);
    recordCost("venice", "cheap", 0.001);
    recordVote("chat", "venice", "pricey", true);
    recordCost("venice", "pricey", 0.1);

    const rows = leaderboard();
    expect(rows.length).toBe(2);
    expect(rows[0].model).toBe("cheap"); // same win-rate, lower cost → higher q/$
    expect(rows[0].qualityPerDollar).toBeGreaterThan(rows[1].qualityPerDollar);
  });
});
