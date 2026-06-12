import { describe, it, expect, beforeEach } from "vitest";
import { scoreCandidates } from "./score";
import { recordVote, resetQuality } from "@/lib/quality";
import type { AppConfig, Classification } from "@/lib/types";

/** Live config with a tunable quality weight (so votes can dominate the score). */
const liveCfg = (qualityWeight: number): AppConfig => ({
  providerMode: "live",
  sessionBudgetUsd: 5,
  maxPaymentPerCallUsd: 0.1,
  network: "base-sepolia",
  venice: { baseUrl: "https://api.venice.ai/api/v1" },
  hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight },
  cache: { enabled: false, simThreshold: 0.83, ttlMs: 1, maxEntries: 1 },
});

const reasoning: Classification = {
  difficulty: 0.8,
  taskClass: "reasoning",
  expectedOutTokens: 800,
};

describe("feedback shifts routing (the learned-quality moat)", () => {
  beforeEach(() => resetQuality());

  it("an upvoted model outranks a downvoted default when quality is weighted", () => {
    const cfg = liveCfg(1); // strong weight: learned votes dominate the score

    const before = scoreCandidates(cfg, reasoning, 50);
    const top = before[0];
    const other = before.find((c) => c.model !== top.model)!;

    // Punish the would-be winner, reward a different candidate.
    for (let i = 0; i < 10; i++) {
      recordVote("reasoning", top.provider, top.model, false);
      recordVote("reasoning", other.provider, other.model, true);
    }

    const after = scoreCandidates(cfg, reasoning, 50);
    expect(after[0].model).not.toBe(top.model);

    const idxOther = after.findIndex(
      (c) => c.provider === other.provider && c.model === other.model,
    );
    const idxTop = after.findIndex(
      (c) => c.provider === top.provider && c.model === top.model,
    );
    expect(idxOther).toBeLessThan(idxTop);
  });
});
