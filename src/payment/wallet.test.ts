import { describe, it, expect } from "vitest";
import { getSigner } from "./wallet";
import type { AppConfig } from "@/lib/types";

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

describe("payment/wallet.getSigner", () => {
  it("throws in mock mode", async () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "mock", walletPrivateKey: undefined };
    await expect(getSigner(cfg)).rejects.toThrow(/mock mode/);
  });

  it("throws when walletPrivateKey is absent in live mode", async () => {
    const cfg: AppConfig = { ...BASE_CFG, providerMode: "live", walletPrivateKey: undefined };
    await expect(getSigner(cfg)).rejects.toThrow(/WALLET_PRIVATE_KEY/);
  });

  // NOTE: We cannot test the happy path here without making a live network call
  // (createSigner from x402-fetch derives an account from the key and may contact
  // an RPC). Live signer creation is verified manually with a real private key + testnet.
});
