import { describe, it, expect, afterEach } from "vitest";
import {
  decodeReceipt,
  facilitatorKind,
  getFacilitatorConfig,
  facilitatorChain,
  facilitatorUrl,
  cdpFacilitatorCredsPresent,
} from "./facilitator";
import type { AppConfig } from "@/lib/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PUBLIC_URL = "https://x402.org/facilitator";

function cfg(facilitator = PUBLIC_URL): AppConfig {
  return {
    providerMode: "live",
    sessionBudgetUsd: 5,
    maxPaymentPerCallUsd: 0.1,
    network: "base",
    facilitatorUrl: facilitator,
    venice: { baseUrl: "https://api.venice.ai/api/v1" },
    hyperbolic: { url: "https://hyperbolic-x402.vercel.app/v1/chat/completions" },
    routing: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0 },
    cache: { enabled: true, simThreshold: 0.83, ttlMs: 86400000, maxEntries: 500 },
  } as AppConfig;
}

/** Build a valid X-PAYMENT-RESPONSE header (base64 of the receipt JSON). */
function encodeReceipt(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

afterEach(() => {
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.BEAMR_FALLBACK_FACILITATORS;
});

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

// ── facilitator selection ──────────────────────────────────────────────────

describe("facilitator config selection", () => {
  it("defaults to the public facilitator when no CDP creds are set", () => {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    expect(cdpFacilitatorCredsPresent()).toBe(false);
    expect(facilitatorKind()).toBe("public");

    const c = getFacilitatorConfig(cfg());
    expect(String(c.url)).toBe(PUBLIC_URL);
    expect(c.createAuthHeaders).toBeUndefined();
  });

  it("selects the CDP-hosted facilitator when both CDP creds are present", () => {
    process.env.CDP_API_KEY_ID = "test-id";
    process.env.CDP_API_KEY_SECRET = "test-secret";
    expect(cdpFacilitatorCredsPresent()).toBe(true);
    expect(facilitatorKind()).toBe("cdp");

    const c = getFacilitatorConfig(cfg());
    expect(String(c.url)).toContain("api.cdp.coinbase.com");
    // CDP config carries an auth-header factory (JWT signer).
    expect(typeof c.createAuthHeaders).toBe("function");
  });

  it("facilitatorUrl reflects the active config", () => {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    expect(facilitatorUrl(cfg())).toBe(PUBLIC_URL);

    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    expect(facilitatorUrl(cfg())).toContain("api.cdp.coinbase.com");
  });
});

// ── failover chain ──────────────────────────────────────────────────────────

describe("facilitatorChain", () => {
  it("is just the public facilitator when nothing else is configured", () => {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    const chain = facilitatorChain(cfg());
    expect(chain.map((c) => String(c.url))).toEqual([PUBLIC_URL]);
  });

  it("puts CDP first, then the public url as the first fallback", () => {
    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    const chain = facilitatorChain(cfg());
    expect(String(chain[0].url)).toContain("api.cdp.coinbase.com");
    expect(String(chain[1].url)).toBe(PUBLIC_URL);
  });

  it("appends extra fallbacks from BEAMR_FALLBACK_FACILITATORS, de-duplicated", () => {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    process.env.BEAMR_FALLBACK_FACILITATORS =
      "https://xpay.example/facilitator, https://oz.example/facilitator, https://x402.org/facilitator";
    const urls = facilitatorChain(cfg()).map((c) => String(c.url));
    expect(urls).toEqual([
      PUBLIC_URL,
      "https://xpay.example/facilitator",
      "https://oz.example/facilitator",
      // the third entry duplicates the primary and is dropped
    ]);
  });
});
