import { describe, it, expect, vi } from "vitest";
import { createPaymentHeader } from "x402/client";
import { getAddress } from "viem";
import type { AppConfig } from "@/lib/types";
import { cdpX402Account, type SignEvmTypedData } from "./cdpSigner";
import { buildPaymentRequirements, decodePaymentHeader } from "./seller";

/**
 * Phase D spike — the load-bearing question: can a CDP embedded wallet produce
 * an x402 `X-PAYMENT` header that BEAMR's own server-side decoder accepts?
 *
 * We mock CDP's `signEvmTypedData` (no network), drive the REAL x402 client
 * encoder through the adapter, and assert the result round-trips through the
 * server's `decodePaymentHeader`. This proves payload shape + the EIP-712 domain
 * handling end-to-end. (Signature *validity* is a facilitator concern, not
 * testable offline, so a well-formed placeholder signature is used.)
 *
 * Target network: base mainnet (the chosen go-live chain).
 */

const WALLET = getAddress("0x" + "ab".repeat(20));
const PAY_TO = getAddress("0x" + "12".repeat(20));
const MOCK_SIG = "0x" + "a".repeat(130); // 65-byte sig, passes PaymentPayloadSchema
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base mainnet

function cfg(): AppConfig {
  return {
    providerMode: "live",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base",
    facilitatorUrl: "https://x402.org/facilitator",
    venice: { baseUrl: "https://api.venice.ai/api/v1" },
    hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
    sell: {
      enabled: true,
      payTo: PAY_TO,
      priceWeakUsd: 0.002,
      priceStrongUsd: 0.01,
      maxTimeoutSeconds: 120,
    },
  } as AppConfig;
}

// $5 top-up → 5_000_000 atomic USDC (6 decimals).
const reqs = () =>
  buildPaymentRequirements(cfg(), {
    atomicUsdc: BigInt(5_000_000),
    resource: "/api/credit/topup",
    description: "BEAMR credit top-up ($5)",
  });

describe("cdpX402Account — x402 createPaymentHeader round-trip (base mainnet)", () => {
  it("produces an X-PAYMENT header the server decodes into a valid PaymentPayload", async () => {
    const signEvmTypedData = vi.fn<SignEvmTypedData>(async () => ({
      signature: MOCK_SIG,
    }));
    const account = cdpX402Account(WALLET, signEvmTypedData);

    // The real x402 client encoder — exactly what the browser would call.
    const header = await createPaymentHeader(account as never, 1, reqs());
    expect(typeof header).toBe("string");
    expect(header.length).toBeGreaterThan(0);

    // Server-side decode (the same call /api/credit/topup makes on the 2nd POST).
    const payload = decodePaymentHeader(header);
    expect(payload).not.toBeNull();
    expect(payload!.scheme).toBe("exact");
    expect(payload!.network).toBe("base");

    const auth = (payload!.payload as { authorization: Record<string, string> })
      .authorization;
    expect(getAddress(auth.from)).toBe(WALLET);
    expect(getAddress(auth.to)).toBe(PAY_TO);
    expect(auth.value).toBe("5000000");
    expect((payload!.payload as { signature: string }).signature).toBe(MOCK_SIG);
  });

  it("signs the correct EIP-3009 typed data (USDC domain on chainId 8453, with EIP712Domain)", async () => {
    let captured: Record<string, unknown> | undefined;
    const signEvmTypedData = vi.fn<SignEvmTypedData>(async ({ evmAccount, typedData }) => {
      expect(getAddress(evmAccount)).toBe(WALLET);
      captured = typedData;
      return { signature: MOCK_SIG };
    });

    await createPaymentHeader(cdpX402Account(WALLET, signEvmTypedData) as never, 1, reqs());

    expect(signEvmTypedData).toHaveBeenCalledOnce();
    const td = captured as {
      types: Record<string, unknown[]>;
      domain: Record<string, unknown>;
      primaryType: string;
      message: Record<string, string>;
    };

    // The adapter must inject EIP712Domain (x402 omits it; CDP requires it).
    expect(td.types.EIP712Domain).toBeDefined();
    expect(td.types.TransferWithAuthorization).toBeDefined();
    expect(td.primaryType).toBe("TransferWithAuthorization");

    // Domain points at USDC on Base mainnet.
    expect(td.domain.chainId).toBe(8453);
    expect(getAddress(td.domain.verifyingContract as string)).toBe(getAddress(BASE_USDC));
    expect(typeof td.domain.name).toBe("string");

    // Message is the exact transfer being authorized.
    expect(getAddress(td.message.from)).toBe(WALLET);
    expect(getAddress(td.message.to)).toBe(PAY_TO);
    expect(td.message.value).toBe("5000000");
  });

  it("rejects accidental use of the non-signing methods", async () => {
    const account = cdpX402Account(WALLET, async () => ({ signature: MOCK_SIG }));
    await expect(account.signMessage()).rejects.toThrow(/not supported/);
    await expect(account.signTransaction()).rejects.toThrow(/not supported/);
  });
});
