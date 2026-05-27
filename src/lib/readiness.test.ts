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
    facilitatorUrl: "https://x402.org/facilitator",
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
  delete process.env.BILLZ_WALLET_PROVIDER;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_WALLET_SECRET;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_TOKEN;
});

afterEach(() => {
  resetStore();
  delete process.env.BILLZ_WALLET_PROVIDER;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_WALLET_SECRET;
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

  it("live + key wallet + key set on mainnet is live-ready (with risk warnings)", async () => {
    const r = await assessReadiness(cfg());
    expect(r.liveReady).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.wallet).toEqual({ provider: "key", configured: true });
    // Mainnet + key wallet + memory store + public facilitator → three warnings.
    const w = r.warnings.join(" ");
    expect(w).toMatch(/process-local/); // no shared store
    expect(w).toMatch(/MPC custody/); // raw key wallet
    expect(w).toMatch(/public facilitator/); // no CDP facilitator
  });

  it("live + cdp provider without creds is blocked", async () => {
    process.env.BILLZ_WALLET_PROVIDER = "cdp";
    const r = await assessReadiness(cfg({ walletPrivateKey: undefined }));
    expect(r.liveReady).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/CDP wallet creds incomplete/);
    expect(r.wallet.provider).toBe("cdp");
  });

  it("live + cdp provider + full creds selects the CDP facilitator and is live-ready", async () => {
    process.env.BILLZ_WALLET_PROVIDER = "cdp";
    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    process.env.CDP_WALLET_SECRET = "wallet-secret";
    const r = await assessReadiness(cfg({ walletPrivateKey: undefined }));
    expect(r.liveReady).toBe(true);
    expect(r.wallet).toEqual({ provider: "cdp", configured: true });
    expect(r.facilitator.kind).toBe("cdp");
    // CDP facilitator present → no public-facilitator warning; still warns on store.
    const w = r.warnings.join(" ");
    expect(w).not.toMatch(/public facilitator/);
    expect(w).not.toMatch(/MPC custody/);
    expect(w).toMatch(/process-local/);
  });

  it("memory store is reported reachable but not shared", async () => {
    const r = await assessReadiness(cfg());
    expect(r.store).toEqual({ id: "memory", shared: false, reachable: true });
  });

  it("live on testnet warns to switch the network", async () => {
    const r = await assessReadiness(cfg({ network: "base-sepolia" }));
    expect(r.mainnet).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/switch BILLZ_NETWORK=base/);
  });
});
