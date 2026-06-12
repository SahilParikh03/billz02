import { describe, it, expect } from "vitest";
import { getSigner, getWalletClient, getPublicClient, chainFor } from "./wallet";
import type { AppConfig } from "@/lib/types";
import type { Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CFG: Omit<AppConfig, "providerMode" | "walletPrivateKey"> = {
  sessionBudgetUsd: 5,
  maxPaymentPerCallUsd: 0.10,
  network: "base-sepolia",
  venice: { baseUrl: "https://api.venice.ai/api/v1" },
  hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
  routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
  cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
};

const KEY = ("0x" + "1".repeat(64)) as Hex;

// ── chainFor() ────────────────────────────────────────────────────────────────

describe("chainFor()", () => {
  it("maps 'base' to Base mainnet and everything else to Base Sepolia", () => {
    expect(chainFor("base").id).toBe(base.id);
    expect(chainFor("base-sepolia").id).toBe(baseSepolia.id);
    expect(chainFor("anything-else").id).toBe(baseSepolia.id);
  });
});

// ── getSigner() — guard paths (no network calls) ─────────────────────────────

describe("payment/wallet.getSigner", () => {
  it("throws in mock mode", async () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "mock", walletPrivateKey: undefined };
    await expect(getSigner(cfg)).rejects.toThrow(/mock mode/);
  });

  it("throws when walletPrivateKey is absent in live mode", async () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "live", walletPrivateKey: undefined };
    await expect(getSigner(cfg)).rejects.toThrow(/WALLET_PRIVATE_KEY/);
  });

  // NOTE: the "key" happy path is not tested here — createSigner contacts an RPC.
});

// ── getWalletClient() / getPublicClient() — guards ───────────────────────────

describe("payment/wallet client builders", () => {
  it("getWalletClient throws in mock mode", () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "mock", walletPrivateKey: KEY };
    expect(() => getWalletClient(cfg)).toThrow(/mock mode/);
  });

  it("getWalletClient throws when the router key is unset", () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "live", walletPrivateKey: undefined };
    expect(() => getWalletClient(cfg)).toThrow(/WALLET_PRIVATE_KEY/);
  });

  it("getWalletClient builds a client bound to the configured chain", () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "live", walletPrivateKey: KEY };
    const client = getWalletClient(cfg);
    expect(client.chain?.id).toBe(baseSepolia.id);
    expect(client.account?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("getPublicClient builds a read-only client without a key", () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "live", walletPrivateKey: undefined };
    const client = getPublicClient(cfg);
    expect(client.chain?.id).toBe(baseSepolia.id);
  });
});
