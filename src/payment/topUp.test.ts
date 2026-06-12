import { describe, it, expect, vi } from "vitest";
import { getAddress } from "viem";
import type { AppConfig } from "@/lib/types";
import { buildPaymentRequirements, decodePaymentHeader } from "@/payment/seller";
import { x402Account, type SignTypedDataFn } from "@/payment/x402Account";
import { runTopUp } from "./topUp";

/**
 * The browser two-step x402 top-up, end to end through the REAL x402 client
 * encoder and the server's own decoder. fetch + the signer are mocked (no
 * network, no wallet); everything between is the real signer-agnostic path.
 */

const WALLET = getAddress("0x" + "ab".repeat(20));
const PAY_TO = getAddress("0x" + "12".repeat(20));
const MOCK_SIG = "0x" + "a".repeat(130);

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

const OFFER = buildPaymentRequirements(cfg(), {
  atomicUsdc: BigInt(5_000_000),
  resource: "/api/credit/topup",
  description: "BEAMR credit top-up ($5)",
});

const sign = vi.fn<SignTypedDataFn>(async () => MOCK_SIG);
const account = () => x402Account(WALLET, sign);

const json = (status: number, b: unknown) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const hasPayment = (init?: RequestInit) =>
  !!init?.headers && "X-PAYMENT" in (init.headers as Record<string, string>);

describe("runTopUp", () => {
  it("does the 402 → sign → pay round trip and returns the credited balance", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      hasPayment(init)
        ? json(200, { ok: true, credited: 5, balance: 5, txHash: "0xdeadbeef" })
        : json(402, { x402Version: 1, accepts: [OFFER] }),
    );

    const result = await runTopUp(account(), 5, fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, credited: 5, balance: 5, txHash: "0xdeadbeef" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(hasPayment(firstInit)).toBe(false);
    // First POST carries the wallet id as X-Beamr-User.
    expect((firstInit.headers as Record<string, string>)["X-Beamr-User"]).toBe(WALLET);

    const header = (secondInit.headers as Record<string, string>)["X-PAYMENT"];
    const payload = decodePaymentHeader(header);
    expect(payload).not.toBeNull();
    const auth = (payload!.payload as { authorization: Record<string, string> }).authorization;
    expect(getAddress(auth.from)).toBe(WALLET);
    expect(auth.value).toBe("5000000");
  });

  it("surfaces a step-1 rejection without signing or a second call", async () => {
    const fetchMock = vi.fn(async () =>
      json(400, { error: { message: "amount_usd must be a positive number", type: "invalid_request_error" } }),
    );
    const localSign = vi.fn<SignTypedDataFn>(async () => MOCK_SIG);

    const result = await runTopUp(
      x402Account(WALLET, localSign),
      0,
      fetchMock as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/amount_usd/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localSign).not.toHaveBeenCalled();
  });

  it("surfaces a verification failure on the paid call", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      hasPayment(init)
        ? json(402, { x402Version: 1, error: "payment invalid: insufficient_funds", accepts: [OFFER] })
        : json(402, { x402Version: 1, accepts: [OFFER] }),
    );

    const result = await runTopUp(account(), 5, fetchMock as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/insufficient_funds/);
  });

  it("surfaces a settlement failure on the paid call", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      hasPayment(init)
        ? json(402, { error: { message: "settlement failed: duplicate_settlement", type: "payment_error" } })
        : json(402, { x402Version: 1, accepts: [OFFER] }),
    );

    const result = await runTopUp(account(), 5, fetchMock as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/settlement failed/);
  });
});
