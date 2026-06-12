import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetStore } from "@/lib/store";
import { getCreditBalance } from "@/lib/credit";

// Mock the in-process facilitator so verify/settle never touch viem/the chain
// (same approach as seller.test.ts). decode/build still run for real against
// x402 schemas.
const verify = vi.fn();
const settle = vi.fn();
vi.mock("@/payment/localFacilitator", () => ({
  createLocalFacilitator: vi.fn(() => ({ verify, settle })),
}));

import { POST } from "./route";

const WALLET = "0x" + "ab".repeat(20);
const PAY_TO = "0x" + "1".repeat(40);

/** A schema-valid x402 PaymentPayload, base64-encoded for the X-PAYMENT header. */
const PAYLOAD = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: "0x" + "a".repeat(130),
    authorization: {
      from: "0x" + "1".repeat(40),
      to: "0x" + "2".repeat(40),
      value: "5000000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x" + "b".repeat(64),
    },
  },
};
const PAYMENT_HEADER = Buffer.from(JSON.stringify(PAYLOAD)).toString("base64");

function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request("http://localhost/api/credit/topup", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  verify.mockReset();
  settle.mockReset();
  resetStore();
  process.env.BEAMR_SELL_PAY_TO = PAY_TO;
  process.env.BEAMR_NETWORK = "base-sepolia";
});

afterEach(() => {
  delete process.env.BEAMR_SELL_PAY_TO;
  delete process.env.BEAMR_NETWORK;
});

describe("POST /api/credit/topup — validation", () => {
  it("400s when X-Beamr-User is not a wallet address", async () => {
    const res = await post({ amount_usd: 5 }, { "X-Beamr-User": "sess_anon" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/wallet address/);
  });

  it("400s on a non-positive or non-numeric amount", async () => {
    for (const amount_usd of [0, -5, "abc"]) {
      const res = await post({ amount_usd }, { "X-Beamr-User": WALLET });
      expect(res.status).toBe(400);
    }
  });

  it("500s when the treasury (BEAMR_SELL_PAY_TO) is unset", async () => {
    delete process.env.BEAMR_SELL_PAY_TO;
    const res = await post({ amount_usd: 5 }, { "X-Beamr-User": WALLET });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/BEAMR_SELL_PAY_TO/);
  });
});

describe("POST /api/credit/topup — x402 flow", () => {
  it("returns 402 with the x402 offer for the requested amount when unpaid", async () => {
    const res = await post({ amount_usd: 5 }, { "X-Beamr-User": WALLET });
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      x402Version: number;
      accepts: { payTo: string; maxAmountRequired: string; network: string }[];
    };
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0].payTo).toBe(PAY_TO);
    expect(body.accepts[0].network).toBe("base-sepolia");
    // $5 → 5_000_000 atomic USDC (6 decimals).
    expect(body.accepts[0].maxAmountRequired).toBe("5000000");
    // Nothing settled, nothing credited.
    expect(await getCreditBalance(WALLET)).toBe(0);
  });

  it("credits the settled amount on a verified + settled payment", async () => {
    verify.mockResolvedValueOnce({ isValid: true, payer: WALLET });
    settle.mockResolvedValueOnce({
      success: true,
      transaction: "0xdeadbeef",
      network: "base-sepolia",
      payer: WALLET,
    });

    const res = await post(
      { amount_usd: 5 },
      { "X-Beamr-User": WALLET, "X-PAYMENT": PAYMENT_HEADER },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    const body = (await res.json()) as {
      ok: boolean;
      credited: number;
      balance: number;
      txHash: string;
    };
    expect(body.ok).toBe(true);
    expect(body.credited).toBeCloseTo(5, 6);
    expect(body.balance).toBeCloseTo(5, 6);
    expect(body.txHash).toBe("0xdeadbeef");
    // The balance is now real, spendable credit.
    expect(await getCreditBalance(WALLET)).toBeCloseTo(5, 6);
  });

  it("does not credit when verification fails", async () => {
    verify.mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" });

    const res = await post(
      { amount_usd: 5 },
      { "X-Beamr-User": WALLET, "X-PAYMENT": PAYMENT_HEADER },
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/insufficient_funds/);
    expect(settle).not.toHaveBeenCalled();
    expect(await getCreditBalance(WALLET)).toBe(0);
  });

  it("does not credit when settlement fails after a valid verify", async () => {
    verify.mockResolvedValueOnce({ isValid: true, payer: WALLET });
    settle.mockResolvedValueOnce({ success: false, errorReason: "duplicate_settlement" });

    const res = await post(
      { amount_usd: 5 },
      { "X-Beamr-User": WALLET, "X-PAYMENT": PAYMENT_HEADER },
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/settlement failed: duplicate_settlement/);
    expect(await getCreditBalance(WALLET)).toBe(0);
  });
});
