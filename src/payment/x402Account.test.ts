import { describe, it, expect, vi } from "vitest";
import { createPaymentHeader } from "x402/client";
import { getAddress } from "viem";
import type { AppConfig } from "@/lib/types";
import { x402Account, type SignTypedDataFn, type TypedData } from "./x402Account";
import { buildPaymentRequirements, decodePaymentHeader } from "./seller";

/**
 * The rail-agnostic signer must produce an x402 `X-PAYMENT` header that BEAMR's
 * own server-side decoder accepts. We mock the injected `signTypedData` (no
 * wallet), drive the REAL x402 client encoder through the adapter, and assert
 * the result round-trips through `decodePaymentHeader`. Crucially: unlike the
 * old CDP adapter, EIP712Domain must NOT be injected (viem/wagmi infer it).
 */

const WALLET = getAddress("0x" + "ab".repeat(20));
const PAY_TO = getAddress("0x" + "12".repeat(20));
const MOCK_SIG = "0x" + "a".repeat(130); // 65-byte sig, passes PaymentPayloadSchema
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function cfg(): AppConfig {
  return {
    providerMode: "live",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base",
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

const reqs = () =>
  buildPaymentRequirements(cfg(), {
    atomicUsdc: BigInt(5_000_000),
    resource: "/api/credit/topup",
    description: "BEAMR credit top-up ($5)",
  });

describe("x402Account — x402 createPaymentHeader round-trip", () => {
  it("produces an X-PAYMENT header the server decodes into a valid PaymentPayload", async () => {
    const signTypedData = vi.fn<SignTypedDataFn>(async () => MOCK_SIG);
    const account = x402Account(WALLET, signTypedData);

    const header = await createPaymentHeader(account as never, 1, reqs());
    expect(typeof header).toBe("string");
    expect(header.length).toBeGreaterThan(0);

    const payload = decodePaymentHeader(header);
    expect(payload).not.toBeNull();
    expect(payload!.scheme).toBe("exact");
    expect(payload!.network).toBe("base");

    const auth = (payload!.payload as { authorization: Record<string, string> }).authorization;
    expect(getAddress(auth.from)).toBe(WALLET);
    expect(getAddress(auth.to)).toBe(PAY_TO);
    expect(auth.value).toBe("5000000");
    expect((payload!.payload as { signature: string }).signature).toBe(MOCK_SIG);
  });

  it("signs the EIP-3009 typed data WITHOUT injecting EIP712Domain", async () => {
    let captured: TypedData | undefined;
    const signTypedData = vi.fn<SignTypedDataFn>(async (data) => {
      captured = data;
      return MOCK_SIG;
    });

    await createPaymentHeader(x402Account(WALLET, signTypedData) as never, 1, reqs());

    expect(signTypedData).toHaveBeenCalledOnce();
    const td = captured!;
    // The adapter must NOT add EIP712Domain — viem infers it from `domain`.
    expect(td.types.EIP712Domain).toBeUndefined();
    expect(td.types.TransferWithAuthorization).toBeDefined();
    expect(td.primaryType).toBe("TransferWithAuthorization");

    expect(td.domain.chainId).toBe(8453);
    expect(getAddress(td.domain.verifyingContract as string)).toBe(getAddress(BASE_USDC));

    const message = td.message as Record<string, string>;
    expect(getAddress(message.from)).toBe(WALLET);
    expect(getAddress(message.to)).toBe(PAY_TO);
    expect(message.value).toBe("5000000");
  });

  it("rejects accidental use of the non-signing methods", async () => {
    const account = x402Account(WALLET, async () => MOCK_SIG);
    await expect(account.signMessage()).rejects.toThrow(/not supported/);
    await expect(account.signTransaction()).rejects.toThrow(/not supported/);
  });
});
