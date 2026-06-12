import { describe, it, expect } from "vitest";
import { decodeReceipt } from "./facilitator";

/** Build a valid X-PAYMENT-RESPONSE header (base64 of the receipt JSON). */
function encodeReceipt(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

// ── decodeReceipt ───────────────────────────────────────────────────────────

describe("decodeReceipt", () => {
  it("returns {} for null / undefined / empty header", () => {
    expect(decodeReceipt(null)).toEqual({});
    expect(decodeReceipt(undefined)).toEqual({});
    expect(decodeReceipt("")).toEqual({});
  });

  it("returns {} for a malformed (non-base64-JSON) header", () => {
    expect(decodeReceipt("not-valid-base64-$$$")).toEqual({});
  });

  it("extracts settlementTxHash from a successful receipt", () => {
    const header = encodeReceipt({
      success: true,
      transaction: "0xabc123",
      network: "base",
      payer: "0xdef456",
    });
    expect(decodeReceipt(header)).toEqual({ settlementTxHash: "0xabc123" });
  });

  it("returns {} when the receipt reports failure", () => {
    const header = encodeReceipt({ success: false, transaction: "0xabc123" });
    expect(decodeReceipt(header)).toEqual({});
  });

  it("returns {} when success but no transaction hash", () => {
    const header = encodeReceipt({ success: true, network: "base" });
    expect(decodeReceipt(header)).toEqual({});
  });
});
