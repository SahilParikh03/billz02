import { describe, it, expect, afterEach } from "vitest";
import { POST } from "./route";

/**
 * Route-level tests for the seller-side x402 paywall wiring (Phase 1).
 *
 * These exercise the *gating* paths that don't touch a facilitator:
 *  - paywall off  → free path unchanged (mock provider)
 *  - paywall on, no X-PAYMENT → 402 with x402 `accepts`
 *  - paywall on, streaming     → 400 (Phase 1 is non-streaming only)
 *  - paywall on, payTo unset    → 500 misconfig
 * The verified/settled happy path is covered by seller.test.ts.
 */

const SELL_ENV = [
  "BEAMR_SELL_ENABLED",
  "BEAMR_SELL_PAY_TO",
  "BEAMR_NETWORK",
  "BEAMR_PROVIDER_MODE",
];

afterEach(() => {
  for (const k of SELL_ENV) delete process.env[k];
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const HI = { messages: [{ role: "user", content: "hi" }], stream: false };

describe("POST /api/v1/chat/completions — paywall off (default)", () => {
  it("serves the free path with no payment headers", async () => {
    const res = await post(HI);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
    const json = (await res.json()) as { object: string; choices: unknown[] };
    expect(json.object).toBe("chat.completion");
    expect(json.choices).toHaveLength(1);
  });
});

describe("POST /api/v1/chat/completions — paywall on", () => {
  function enable(payTo = "0x" + "1".repeat(40)) {
    process.env.BEAMR_SELL_ENABLED = "1";
    process.env.BEAMR_NETWORK = "base-sepolia";
    if (payTo) process.env.BEAMR_SELL_PAY_TO = payTo;
  }

  it("returns 402 with x402 accepts when no X-PAYMENT header is present", async () => {
    enable();
    const res = await post(HI);
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      x402Version: number;
      error: string;
      accepts: { scheme: string; network: string; payTo: string; maxAmountRequired: string }[];
    };
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe("payment required");
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.accepts[0].network).toBe("base-sepolia");
    expect(body.accepts[0].payTo).toBe("0x" + "1".repeat(40));
    // "hi" is a trivial prompt → weak tier → 0.002 USD → 2000 atomic USDC.
    expect(body.accepts[0].maxAmountRequired).toBe("2000");
  });

  it("rejects streaming requests with 400 (Phase 1 is non-streaming only)", async () => {
    enable();
    const res = await post({ messages: [{ role: "user", content: "hi" }], stream: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/stream:false/);
  });

  it("returns 500 when payTo is misconfigured", async () => {
    enable("");
    const res = await post(HI);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/BEAMR_SELL_PAY_TO/);
  });
});
