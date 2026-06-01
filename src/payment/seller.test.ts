import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppConfig } from "@/lib/types";
import type { PaymentPayload, PaymentRequirements } from "x402/types";

// Mock the facilitator so verify/settle never touch the network.
const verify = vi.fn();
const settle = vi.fn();
vi.mock("x402/verify", () => ({
  useFacilitator: vi.fn(() => ({ verify, settle })),
}));

import {
  buildPaymentRequirements,
  decodePaymentHeader,
  paymentRequiredBody,
  settlePayment,
  verifyPayment,
} from "./seller";

function cfg(over: Partial<AppConfig["sell"]> = {}): AppConfig {
  return {
    providerMode: "live",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base-sepolia",
    facilitatorUrl: "https://x402.org/facilitator",
    venice: { baseUrl: "https://api.venice.ai/api/v1" },
    hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
    sell: {
      enabled: true,
      payTo: "0x" + "1".repeat(40),
      priceWeakUsd: 0.002,
      priceStrongUsd: 0.01,
      maxTimeoutSeconds: 120,
      ...over,
    },
  } as AppConfig;
}

const VALID_PAYLOAD = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: "0x" + "a".repeat(130),
    authorization: {
      from: "0x" + "1".repeat(40),
      to: "0x" + "2".repeat(40),
      value: "2000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x" + "b".repeat(64),
    },
  },
};

const reqs = (): PaymentRequirements =>
  buildPaymentRequirements(cfg(), {
    atomicUsdc: BigInt(2000),
    resource: "/api/v1/chat/completions",
    description: "test",
  });

const FAC = { url: "https://x402.org/facilitator" } as never;

beforeEach(() => {
  verify.mockReset();
  settle.mockReset();
});

afterEach(() => {
  delete process.env.BEAMR_FALLBACK_FACILITATORS;
});

// ── buildPaymentRequirements ──────────────────────────────────────────────────

describe("buildPaymentRequirements", () => {
  it("builds an exact-scheme USDC offer for the network", () => {
    const r = buildPaymentRequirements(cfg(), {
      atomicUsdc: BigInt(10000),
      resource: "/api/v1/chat/completions",
      description: "BEAMR inference (strong tier)",
    });
    expect(r.scheme).toBe("exact");
    expect(r.network).toBe("base-sepolia");
    expect(r.maxAmountRequired).toBe("10000");
    expect(r.payTo).toBe("0x" + "1".repeat(40));
    expect(r.mimeType).toBe("application/json");
    expect(r.maxTimeoutSeconds).toBe(120);
    // Asset + EIP-712 domain come from x402's default-asset table (USDC).
    expect(r.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.extra).toMatchObject({ name: expect.any(String), version: expect.any(String) });
  });

  it("throws when payTo is unset", () => {
    expect(() =>
      buildPaymentRequirements(cfg({ payTo: undefined }), {
        atomicUsdc: BigInt(2000),
        resource: "/x",
        description: "d",
      }),
    ).toThrow(/payTo/);
  });
});

// ── paymentRequiredBody ───────────────────────────────────────────────────────

describe("paymentRequiredBody", () => {
  it("wraps the requirements in an x402 402 body", () => {
    const r = reqs();
    const body = paymentRequiredBody(r);
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe("payment required");
    expect(body.accepts).toEqual([r]);
  });

  it("carries a custom error message", () => {
    expect(paymentRequiredBody(reqs(), "payment invalid: insufficient_funds").error).toBe(
      "payment invalid: insufficient_funds",
    );
  });
});

// ── decodePaymentHeader ───────────────────────────────────────────────────────

describe("decodePaymentHeader", () => {
  it("returns null for missing / empty headers", () => {
    expect(decodePaymentHeader(null)).toBeNull();
    expect(decodePaymentHeader(undefined)).toBeNull();
    expect(decodePaymentHeader("")).toBeNull();
  });

  it("returns null for non-base64 / non-JSON garbage", () => {
    expect(decodePaymentHeader("!!!not-base64!!!")).toBeNull();
    expect(decodePaymentHeader(Buffer.from("not json").toString("base64"))).toBeNull();
  });

  it("returns null for base64 JSON that fails the schema", () => {
    const bad = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact" })).toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });

  it("decodes a valid PaymentPayload", () => {
    const header = Buffer.from(JSON.stringify(VALID_PAYLOAD)).toString("base64");
    const decoded = decodePaymentHeader(header);
    expect(decoded).not.toBeNull();
    expect(decoded?.scheme).toBe("exact");
    expect(decoded?.network).toBe("base-sepolia");
  });
});

// ── verifyPayment ─────────────────────────────────────────────────────────────

describe("verifyPayment", () => {
  const payload = VALID_PAYLOAD as unknown as PaymentPayload;

  it("returns ok with payer + facilitator on a valid payment", async () => {
    verify.mockResolvedValueOnce({ isValid: true, payer: "0xpayer" });
    const out = await verifyPayment(cfg(), payload, reqs());
    expect(out.ok).toBe(true);
    expect(out.payer).toBe("0xpayer");
    expect(out.facilitator).toBeDefined();
  });

  it("returns the invalidReason when the facilitator rejects", async () => {
    verify.mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" });
    const out = await verifyPayment(cfg(), payload, reqs());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("insufficient_funds");
  });

  it("fails over to the next facilitator when the first throws", async () => {
    process.env.BEAMR_FALLBACK_FACILITATORS = "https://fallback.example/facilitator";
    verify.mockRejectedValueOnce(new Error("facilitator down"));
    verify.mockResolvedValueOnce({ isValid: true, payer: "0xpayer" });
    const out = await verifyPayment(cfg(), payload, reqs());
    expect(out.ok).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("reports facilitator_error when every facilitator throws", async () => {
    verify.mockRejectedValue(new Error("down"));
    const out = await verifyPayment(cfg(), payload, reqs());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("facilitator_error");
  });
});

// ── settlePayment ─────────────────────────────────────────────────────────────

describe("settlePayment", () => {
  const payload = VALID_PAYLOAD as unknown as PaymentPayload;

  it("returns the receipt header + tx hash on success", async () => {
    settle.mockResolvedValueOnce({
      success: true,
      transaction: "0xdeadbeef",
      network: "base-sepolia",
      payer: "0xpayer",
    });
    const out = await settlePayment(FAC, payload, reqs());
    expect(out.success).toBe(true);
    expect(out.txHash).toBe("0xdeadbeef");
    expect(typeof out.header).toBe("string");
    expect(out.header!.length).toBeGreaterThan(0);
  });

  it("surfaces a settlement failure reason", async () => {
    settle.mockResolvedValueOnce({ success: false, errorReason: "duplicate_settlement" });
    const out = await settlePayment(FAC, payload, reqs());
    expect(out.success).toBe(false);
    expect(out.error).toBe("duplicate_settlement");
  });

  it("catches a thrown settle and reports the message", async () => {
    settle.mockRejectedValueOnce(new Error("rpc timeout"));
    const out = await settlePayment(FAC, payload, reqs());
    expect(out.success).toBe(false);
    expect(out.error).toBe("rpc timeout");
  });
});
