import { describe, it, expect, afterEach } from "vitest";
import { getSigner, walletProvider } from "./wallet";
import type { AppConfig } from "@/lib/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CFG: Omit<AppConfig, "providerMode" | "walletPrivateKey"> = {
  sessionBudgetUsd: 5,
  maxPaymentPerCallUsd: 0.10,
  network: "base-sepolia",
  facilitatorUrl: "https://x402.org/facilitator",
  venice: { baseUrl: "https://api.venice.ai/api/v1" },
  hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
  cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
};

/**
 * Save and restore BEAMR_WALLET_PROVIDER around each test so env mutations
 * don't leak across cases.
 */
afterEach(() => {
  delete process.env.BEAMR_WALLET_PROVIDER;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_WALLET_SECRET;
});

// ── walletProvider() ─────────────────────────────────────────────────────────

describe("walletProvider()", () => {
  it("returns 'key' by default when env var is absent", () => {
    delete process.env.BEAMR_WALLET_PROVIDER;
    expect(walletProvider()).toBe("key");
  });

  it("returns 'key' when env var is empty string", () => {
    process.env.BEAMR_WALLET_PROVIDER = "";
    expect(walletProvider()).toBe("key");
  });

  it("returns 'cdp' when env var is 'cdp'", () => {
    process.env.BEAMR_WALLET_PROVIDER = "cdp";
    expect(walletProvider()).toBe("cdp");
  });

  it("returns 'key' for any unrecognised value (safe default)", () => {
    process.env.BEAMR_WALLET_PROVIDER = "unknown-provider";
    expect(walletProvider()).toBe("key");
  });
});

// ── getSigner() — guard paths (no network calls) ─────────────────────────────

describe("payment/wallet.getSigner", () => {
  it("throws in mock mode regardless of provider", async () => {
    delete process.env.BEAMR_WALLET_PROVIDER; // default "key"
    const cfg: AppConfig = {
      ...BASE_CFG,
      providerMode: "mock",
      walletPrivateKey: undefined,
    };
    await expect(getSigner(cfg)).rejects.toThrow(/mock mode/);
  });

  it("throws when walletPrivateKey is absent in live mode (key provider)", async () => {
    delete process.env.BEAMR_WALLET_PROVIDER; // default "key"
    const cfg: AppConfig = {
      ...BASE_CFG,
      providerMode: "live",
      walletPrivateKey: undefined,
    };
    await expect(getSigner(cfg)).rejects.toThrow(/WALLET_PRIVATE_KEY/);
  });

  it("throws a helpful CDP setup message when provider=cdp and creds are absent", async () => {
    process.env.BEAMR_WALLET_PROVIDER = "cdp";
    // Ensure no CDP creds leak in from the ambient environment.
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
    const cfg: AppConfig = {
      ...BASE_CFG,
      providerMode: "live",
      walletPrivateKey: undefined,
    };
    await expect(getSigner(cfg)).rejects.toThrow(/CDP Server Wallet credentials/);
  });

  it("CDP error message mentions all three required secrets", async () => {
    process.env.BEAMR_WALLET_PROVIDER = "cdp";
    delete process.env.CDP_API_KEY_ID;
    const cfg: AppConfig = {
      ...BASE_CFG,
      providerMode: "live",
      walletPrivateKey: undefined,
    };
    await expect(getSigner(cfg)).rejects.toThrow(/CDP_API_KEY_ID/);
    await expect(getSigner(cfg)).rejects.toThrow(/CDP_WALLET_SECRET/);
  });

  // NOTE: We cannot test the "key" happy-path here without making a live network
  // call. createSigner from x402-fetch derives an EVM account and contacts an RPC.
  // Live signer creation is verified manually with a real private key + testnet/mainnet.
});
