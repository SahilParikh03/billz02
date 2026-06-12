import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assessReadiness } from "./readiness";
import { resetStore } from "./store";
import type { AppConfig } from "@/lib/types";
import type { Hex } from "viem";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    providerMode: "live",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base",
    walletPrivateKey: ("0x" + "1".repeat(64)) as Hex,
    venice: { baseUrl: "https://api.venice.ai/api/v1" },
    hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
    ...overrides,
  } as AppConfig;
}

beforeEach(() => {
  resetStore();
  delete process.env.REDIS_URL;
  delete process.env.REDIS_TOKEN;
  delete process.env.BEAMR_RPC_URL;
});

afterEach(() => {
  resetStore();
  delete process.env.BEAMR_RPC_URL;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("assessReadiness", () => {
  it("mock mode is not live-ready and reports the mock-mode blocker", async () => {
    const r = await assessReadiness(cfg({ providerMode: "mock" }));
    expect(r.liveReady).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/not 'live'/);
  });

  it("live + key wallet without a private key is blocked", async () => {
    const r = await assessReadiness(cfg({ walletPrivateKey: undefined }));
    expect(r.liveReady).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/WALLET_PRIVATE_KEY/);
  });

  it("live + router key set on mainnet is live-ready (with risk warnings)", async () => {
    const r = await assessReadiness(cfg());
    expect(r.liveReady).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.wallet).toEqual({ provider: "key", configured: true });
    expect(r.facilitator.kind).toBe("local");
    // Mainnet + memory store + no dedicated RPC → two warnings.
    const w = r.warnings.join(" ");
    expect(w).toMatch(/process-local/); // no shared store
    expect(w).toMatch(/BEAMR_RPC_URL/); // no dedicated RPC
  });

  it("a dedicated mainnet RPC drops the RPC warning", async () => {
    process.env.BEAMR_RPC_URL = "https://base-mainnet.example/rpc";
    const r = await assessReadiness(cfg());
    expect(r.liveReady).toBe(true);
    expect(r.facilitator.rpc).toBe("https://base-mainnet.example/rpc");
    expect(r.warnings.join(" ")).not.toMatch(/BEAMR_RPC_URL/);
  });

  it("memory store is reported reachable but not shared", async () => {
    const r = await assessReadiness(cfg());
    expect(r.store).toEqual({ id: "memory", shared: false, reachable: true });
  });

  it("live on testnet warns to switch the network", async () => {
    const r = await assessReadiness(cfg({ network: "base-sepolia" }));
    expect(r.mainnet).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/switch BEAMR_NETWORK=base/);
  });
});
