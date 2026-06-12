import { describe, it, expect } from "vitest";
import { route } from "./select";
import type { AppConfig } from "@/lib/types";

/** Minimal mock config for testing. */
function mockCfg(overrides?: Partial<AppConfig>): AppConfig {
  return {
    providerMode: "mock",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base-sepolia",
    venice: { baseUrl: "https://api.venice.ai/api/v1" },
    hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
    ...overrides,
  };
}

function liveCfg(): AppConfig {
  return mockCfg({ providerMode: "live" });
}

describe("route() — mock mode", () => {
  it("always routes to mock provider", () => {
    const d = route(mockCfg(), { messages: [{ role: "user", content: "hello" }] });
    expect(d.provider).toBe("mock");
  });

  it("uses 'mock-fast' when model is absent", () => {
    const d = route(mockCfg(), { messages: [{ role: "user", content: "hi" }] });
    expect(d.model).toBe("mock-fast");
  });

  it("uses 'mock-fast' when model is 'auto'", () => {
    const d = route(mockCfg(), { model: "auto", messages: [{ role: "user", content: "hi" }] });
    expect(d.model).toBe("mock-fast");
  });

  it("preserves an explicit model id in mock mode", () => {
    const d = route(mockCfg(), { model: "mock-strong", messages: [{ role: "user", content: "hi" }] });
    expect(d.provider).toBe("mock");
    expect(d.model).toBe("mock-strong");
  });

  it("sets a human-readable reason", () => {
    const d = route(mockCfg(), { messages: [{ role: "user", content: "hi" }] });
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe("route() — live mode rule branches", () => {
  it("routes generic chat to an active provider (hyperbolic when no Venice key)", () => {
    const d = route(liveCfg(), {
      messages: [{ role: "user", content: "tell me a story" }],
    });
    // Venice is gated out of the live set unless VENICE_API_KEY is set, so the
    // weak-tier pick falls to the first active provider (hyperbolic).
    expect(d.provider).toBe("hyperbolic");
  });

  it("routes an exact Hyperbolic model id to hyperbolic", () => {
    const d = route(liveCfg(), {
      model: "meta-llama/Llama-3.3-70B-Instruct",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(d.provider).toBe("hyperbolic");
    expect(d.model).toBe("meta-llama/Llama-3.3-70B-Instruct");
    expect(d.reason).toMatch(/hyperbolic/i);
  });

  it("routes an exact Surplus model id to surplus", () => {
    const d = route(liveCfg(), {
      model: "deepseek-v3.2",
      messages: [{ role: "user", content: "write a function" }],
    });
    expect(d.provider).toBe("surplus");
    expect(d.model).toBe("deepseek-v3.2");
  });

  it("does NOT honor an unadvertised model id — falls through to tier/cost routing", () => {
    // Strict supports(): a made-up id matches no provider, so the explicit-model
    // shortcut is skipped and the router scores candidates instead. (Pre-fix,
    // loose substring matching wrongly pinned this to a provider.)
    const d = route(liveCfg(), {
      model: "deepseek-coder",
      messages: [{ role: "user", content: "write a function" }],
    });
    expect(d.reason).not.toMatch(/explicit model/i);
    expect(["hyperbolic", "surplus", "venice", "mock"]).toContain(d.provider);
  });

  // Stage 1 routes by difficulty/tier/cost rather than provider keywords.
  it("routes an easy prompt to the weak (cheap) tier", () => {
    const d = route(liveCfg(), {
      messages: [{ role: "user", content: "hi there" }],
    });
    expect(d.reason).toMatch(/weak tier/);
  });

  it("routes a hard, multi-step reasoning prompt to the strong tier", () => {
    const d = route(liveCfg(), {
      messages: [
        {
          role: "user",
          content:
            "Explain step by step why distributed consensus is hard, and compare Paxos and Raft in detail, analyzing the tradeoffs.",
        },
      ],
    });
    expect(d.reason).toMatch(/strong tier/);
  });

  it("classifies a fenced code prompt as the code task class", () => {
    const d = route(liveCfg(), {
      messages: [
        {
          role: "user",
          content: "write a python function:\n```\ndef f(x):\n  return x\n```",
        },
      ],
    });
    expect(d.reason).toMatch(/^code/);
  });

  it("always includes a reason string", () => {
    const d = route(liveCfg(), { messages: [{ role: "user", content: "test" }] });
    expect(typeof d.reason).toBe("string");
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it("includes a model string in the decision", () => {
    const d = route(liveCfg(), { messages: [{ role: "user", content: "test" }] });
    expect(typeof d.model).toBe("string");
    expect(d.model.length).toBeGreaterThan(0);
  });
});
