import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCreditBalance } from "@/lib/credit";
import { resetStore } from "@/lib/store";

// Mock the Stripe SDK: constructEvent is the signature gate we drive directly.
const constructEvent = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    webhooks = { constructEvent };
  },
}));

import { POST } from "./route";

const WALLET = "0x" + "ab".repeat(20);

function post(rawBody: string, headers: Record<string, string> = { "stripe-signature": "sig_x" }): Promise<Response> {
  return POST(
    new Request("http://localhost/api/credit/stripe/webhook", {
      method: "POST",
      headers,
      body: rawBody,
    }),
  );
}

/** A checkout.session.completed event crediting `userId` with `cents`. */
function completedEvent(id: string, userId: string | undefined, cents: number | null) {
  return {
    id,
    type: "checkout.session.completed",
    data: { object: { metadata: userId ? { userId } : {}, amount_total: cents } },
  };
}

beforeEach(() => {
  constructEvent.mockReset();
  resetStore();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("POST /api/credit/stripe/webhook", () => {
  it("500s when the webhook secret is unset", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await post("{}");
    expect(res.status).toBe(500);
  });

  it("400s when the signature header is missing", async () => {
    const res = await post("{}", {});
    expect(res.status).toBe(400);
  });

  it("400s when signature verification fails", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });
    const res = await post("{}");
    expect(res.status).toBe(400);
  });

  it("credits the ledger on checkout.session.completed", async () => {
    constructEvent.mockReturnValue(completedEvent("evt_1", WALLET, 500));
    const res = await post(JSON.stringify({ any: "raw" }));
    expect(res.status).toBe(200);
    expect(await getCreditBalance(WALLET)).toBeCloseTo(5, 6);
  });

  it("credits an email: identity too", async () => {
    constructEvent.mockReturnValue(completedEvent("evt_email", "email:alice@example.com", 2000));
    await post("{}");
    expect(await getCreditBalance("email:alice@example.com")).toBeCloseTo(20, 6);
  });

  it("credits a replayed event only once (idempotent)", async () => {
    constructEvent.mockReturnValue(completedEvent("evt_dup", WALLET, 500));
    await post("{}");
    const second = await post("{}");
    const body = (await second.json()) as { received: boolean; deduped?: boolean };
    expect(body.deduped).toBe(true);
    expect(await getCreditBalance(WALLET)).toBeCloseTo(5, 6); // still $5, not $10
  });

  it("ignores unrelated event types without crediting", async () => {
    constructEvent.mockReturnValue({ id: "evt_other", type: "payment_intent.created", data: { object: {} } });
    const res = await post("{}");
    expect(res.status).toBe(200);
    expect(await getCreditBalance(WALLET)).toBe(0);
  });
});
