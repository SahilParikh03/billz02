import { describe, it } from "vitest";
import { classify } from "./classify";
import { policyParams } from "./modes";
import type { PolicyMode } from "@/lib/types";

const PROMPTS: Array<[string, string]> = [
  ["trivial", "hi"],
  ["trivial", "thanks!"],
  ["trivial", "what's 2+2"],
  ["factual", "what is the capital of France"],
  ["factual", "who wrote Hamlet"],
  ["simple", "what is a binary search"],
  ["simple", "explain what a binary search is and when to use it"],
  ["medium", "summarize the main benefits of regular cycling"],
  ["medium", "describe how photosynthesis works"],
  ["creative", "write a short poem about the sea"],
  ["creative", "brainstorm five names for a coffee app"],
  ["code", "write a python function to reverse a linked list"],
  ["code", "fix the TypeError in my async handler code"],
  ["reasoning", "explain step by step why the sky is blue"],
  ["reasoning", "compare TCP and UDP and their tradeoffs in detail"],
  ["reasoning", "prove that the square root of 2 is irrational"],
  ["hard", "design a rate limiter: walk through the algorithm, analyze the tradeoffs, and compare token-bucket vs sliding-window in detail"],
];

const tier = (d: number, mode: PolicyMode) =>
  d >= policyParams(mode).difficultyThreshold ? "STRONG" : "weak  ";

describe("classifier calibration", () => {
  it("prints the difficulty distribution across the prompt spectrum", () => {
    const lines = PROMPTS.map(([bucket, p]) => {
      const c = classify([{ role: "user" as const, content: p }]);
      return (
        `${c.difficulty.toFixed(2)}  ${c.taskClass.padEnd(9)} ` +
        `frugal:${tier(c.difficulty, "frugal")} bal:${tier(c.difficulty, "balanced")} prem:${tier(c.difficulty, "premium")}  ` +
        `[${bucket.padEnd(9)}] ${p.slice(0, 52)}`
      );
    });
    console.log("\nDIFF  TASKCLASS  TIER-BY-MODE                                EXPECTED   PROMPT\n" + lines.join("\n") + "\n");
  });
});
