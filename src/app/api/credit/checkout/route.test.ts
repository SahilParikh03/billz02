import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Stripe SDK so no network call happens.
const create = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions: { create } };
  },
}));

import { POST } from "./route";

const WALLET = "0x" + "ab".repeat(20);

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://localhost/api/credit/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_123" });
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

describe("POST /api/credit/checkout", () => {
  it("500s when STRIPE_SECRET_KEY is unset", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await post({ amount_usd: 5, userId: WALLET });
    expect(res.status).toBe(500);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s when userId is not a credit identity", async () => {
    const res = await post({ amount_usd: 5, userId: "sess_anon" });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s on an out-of-range or non-numeric amount", async () => {
    for (const amount_usd of [0, 0.5, 600, "abc"]) {
      const res = await post({ amount_usd, userId: WALLET });
      expect(res.status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a Checkout Session and returns its url (wallet id)", async () => {
    const res = await post({ amount_usd: 5, userId: WALLET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain("checkout.stripe.com");

    const args = create.mock.calls[0][0];
    expect(args.mode).toBe("payment");
    expect(args.metadata).toEqual({ userId: WALLET });
    expect(args.line_items[0].price_data.unit_amount).toBe(500); // $5 → 500 cents
    expect(args.line_items[0].price_data.currency).toBe("usd");
  });

  it("accepts an email: identity too", async () => {
    const res = await post({ amount_usd: 20, userId: "email:alice@example.com" });
    expect(res.status).toBe(200);
    const args = create.mock.calls[0][0];
    expect(args.metadata).toEqual({ userId: "email:alice@example.com" });
    expect(args.line_items[0].price_data.unit_amount).toBe(2000);
  });
});
