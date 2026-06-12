import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppConfig } from "@/lib/types";
import type { PaymentPayload, PaymentRequirements } from "x402/types";

// Mock only the viem CLIENTS (network I/O). chainFor and the real viem helpers
// (getAddress, parseSignature) stay real so the facilitator's own logic runs.
const verifyTypedData = vi.fn();
const readContract = vi.fn();
const waitForTransactionReceipt = vi.fn();
const writeContract = vi.fn();

vi.mock("./wallet", async (orig) => {
  const actual = await orig<typeof import("./wallet")>();
  return {
    ...actual,
    getPublicClient: () => ({ verifyTypedData, readContract, waitForTransactionReceipt }),
    getWalletClient: () => ({ writeContract }),
  };
});

import { createLocalFacilitator } from "./localFacilitator";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FROM = "0x" + "1".repeat(40);
const PAY_TO = "0x" + "2".repeat(40);
const NONCE = "0x" + "b".repeat(64);
// A syntactically valid 65-byte ECDSA signature (r ‖ s ‖ v=0x1b).
const SIG = "0x" + "11".repeat(32) + "22".repeat(32) + "1b";

function cfg(): AppConfig {
  return {
    providerMode: "live",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base-sepolia",
    walletPrivateKey: ("0x" + "1".repeat(64)) as `0x${string}`,
    venice: { baseUrl: "https://api.venice.ai/api/v1" },
    hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
  } as AppConfig;
}

const now = () => Math.floor(Date.now() / 1000);

function payload(over: Partial<{
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  signature: string;
  network: string;
}> = {}): PaymentPayload {
  return {
    x402Version: 1,
    scheme: "exact",
    network: over.network ?? "base-sepolia",
    payload: {
      signature: over.signature ?? SIG,
      authorization: {
        from: FROM,
        to: over.to ?? PAY_TO,
        value: over.value ?? "2000",
        validAfter: over.validAfter ?? "0",
        validBefore: over.validBefore ?? String(now() + 3600),
        nonce: NONCE,
      },
    },
  } as unknown as PaymentPayload;
}

function reqs(over: Partial<{ maxAmountRequired: string; payTo: string }> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: over.maxAmountRequired ?? "2000",
    resource: "/api/credit/topup",
    description: "test",
    mimeType: "application/json",
    payTo: over.payTo ?? PAY_TO,
    maxTimeoutSeconds: 120,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    extra: { name: "USDC", version: "2" },
  } as unknown as PaymentRequirements;
}

/** balanceOf → `bal`, authorizationState → `used`. */
function chainState(bal: bigint, used: boolean) {
  readContract.mockImplementation(({ functionName }: { functionName: string }) =>
    functionName === "balanceOf" ? Promise.resolve(bal) : Promise.resolve(used),
  );
}

beforeEach(() => {
  verifyTypedData.mockReset();
  readContract.mockReset();
  waitForTransactionReceipt.mockReset();
  writeContract.mockReset();
});

// ── verify ────────────────────────────────────────────────────────────────────

describe("localFacilitator.verify", () => {
  it("accepts a well-formed, funded, unused authorization", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    const res = await createLocalFacilitator(cfg()).verify(payload(), reqs());
    expect(res.isValid).toBe(true);
    expect(res.payer).toBe(FROM);
  });

  it("rejects a bad signature", async () => {
    verifyTypedData.mockResolvedValue(false);
    chainState(BigInt(5000), false);
    const res = await createLocalFacilitator(cfg()).verify(payload(), reqs());
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe("invalid_exact_evm_payload_signature");
  });

  it("rejects a recipient that isn't payTo", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    const res = await createLocalFacilitator(cfg()).verify(
      payload({ to: "0x" + "9".repeat(40) }),
      reqs(),
    );
    expect(res.invalidReason).toBe("invalid_exact_evm_payload_recipient_mismatch");
  });

  it("rejects an expired authorization", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    const res = await createLocalFacilitator(cfg()).verify(
      payload({ validBefore: String(now() - 10) }),
      reqs(),
    );
    expect(res.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
  });

  it("rejects a not-yet-valid authorization", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    const res = await createLocalFacilitator(cfg()).verify(
      payload({ validAfter: String(now() + 1000) }),
      reqs(),
    );
    expect(res.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_after");
  });

  it("rejects when the authorized value doesn't cover the price", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    const res = await createLocalFacilitator(cfg()).verify(
      payload({ value: "1000" }),
      reqs({ maxAmountRequired: "2000" }),
    );
    expect(res.invalidReason).toBe("invalid_exact_evm_payload_authorization_value");
  });

  it("rejects an underfunded payer", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(0), false);
    const res = await createLocalFacilitator(cfg()).verify(payload(), reqs());
    expect(res.invalidReason).toBe("insufficient_funds");
  });

  it("rejects a nonce already used on-chain", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), true);
    const res = await createLocalFacilitator(cfg()).verify(payload(), reqs());
    expect(res.invalidReason).toBe("duplicate_settlement");
  });

  it("rejects a network mismatch before touching the chain", async () => {
    const res = await createLocalFacilitator(cfg()).verify(payload({ network: "base" }), reqs());
    expect(res.invalidReason).toBe("invalid_network");
    expect(verifyTypedData).not.toHaveBeenCalled();
  });

  it("soft-fails to unexpected_verify_error when an RPC read throws", async () => {
    verifyTypedData.mockResolvedValue(true);
    readContract.mockRejectedValue(new Error("rpc down"));
    const res = await createLocalFacilitator(cfg()).verify(payload(), reqs());
    expect(res.invalidReason).toBe("unexpected_verify_error");
  });
});

// ── settle ────────────────────────────────────────────────────────────────────

describe("localFacilitator.settle", () => {
  it("broadcasts transferWithAuthorization and reports the tx on success", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    writeContract.mockResolvedValue("0xdeadbeef");
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });

    const res = await createLocalFacilitator(cfg()).settle(payload(), reqs());
    expect(res.success).toBe(true);
    expect(res.transaction).toBe("0xdeadbeef");
    expect(res.network).toBe("base-sepolia");
    // The (v,r,s) overload: 9 args, last three are v, r, s.
    const args = writeContract.mock.calls[0][0].args;
    expect(args).toHaveLength(9);
    expect(args[6]).toBe(0x1b); // v = 27
  });

  it("reports invalid_transaction_state when the tx reverts", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    writeContract.mockResolvedValue("0xabc");
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });

    const res = await createLocalFacilitator(cfg()).settle(payload(), reqs());
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("invalid_transaction_state");
    expect(res.transaction).toBe("0xabc");
  });

  it("does not broadcast when re-verification fails", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(0), false); // underfunded → verify fails
    const res = await createLocalFacilitator(cfg()).settle(payload(), reqs());
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("insufficient_funds");
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("reports unexpected_settle_error when the broadcast throws", async () => {
    verifyTypedData.mockResolvedValue(true);
    chainState(BigInt(5000), false);
    writeContract.mockRejectedValue(new Error("gas estimation failed"));
    const res = await createLocalFacilitator(cfg()).settle(payload(), reqs());
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("unexpected_settle_error");
    expect(res.transaction).toBe("");
  });
});
