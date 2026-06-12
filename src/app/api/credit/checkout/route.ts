/**
 * Stripe card top-up — create a Checkout Session (Phase E, Rail B).
 *
 * POST /api/credit/checkout  { amount_usd, userId }
 *
 * The card counterpart to the wallet x402 top-up. A user who holds no crypto
 * funds credit with a card: this creates a hosted Stripe Checkout Session and
 * returns its `url` for the browser to redirect to. The credit is granted later,
 * asynchronously, by the webhook (`./stripe/webhook`) once Stripe confirms the
 * payment — never here, because the charge hasn't happened yet at session
 * creation. The `userId` is carried in session metadata so the webhook knows
 * whose ledger to credit.
 *
 * Uses hosted Checkout (redirect) only — no client SDK or publishable key. The
 * secret key is server-only.
 */

import Stripe from "stripe";
import { isCreditUser } from "@/lib/credit";

// Reads the raw request body / uses node crypto in the sibling webhook; keep the
// whole credit/stripe surface on the Node runtime for consistency.
export const runtime = "nodejs";

/** Card top-up bounds (USD). Mirrors the wallet presets' spirit but card-sized. */
const MIN_USD = 1;
const MAX_USD = 500;

function err(message: string, type: string, status: number): Response {
  return Response.json({ error: { message, type } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return err("card payments are not configured (STRIPE_SECRET_KEY unset)", "server_error", 500);
  }

  let body: { amount_usd?: unknown; userId?: unknown };
  try {
    body = (await request.json()) as { amount_usd?: unknown; userId?: unknown };
  } catch {
    return err("invalid JSON body", "invalid_request_error", 400);
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!isCreditUser(userId)) {
    return err(
      "userId must be a 0x-prefixed EVM wallet address or an email:<id>",
      "invalid_request_error",
      400,
    );
  }

  const amountUsd = Number(body.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_USD || amountUsd > MAX_USD) {
    return err(
      `amount_usd must be a number between ${MIN_USD} and ${MAX_USD}`,
      "invalid_request_error",
      400,
    );
  }

  const origin = request.headers.get("origin") || new URL(request.url).origin;
  const stripe = new Stripe(secret);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(amountUsd * 100),
            product_data: { name: "BEAMR credit top-up" },
          },
        },
      ],
      // The webhook reads this to credit the right ledger after payment.
      metadata: { userId },
      success_url: `${origin}/?topup=success`,
      cancel_url: `${origin}/?topup=cancel`,
    });

    return Response.json({ url: session.url });
  } catch (e) {
    const raw = (e as Error).message;
    // Surface the real Stripe reason to the server log (not the customer).
    console.error("[credit/checkout] Stripe session create failed:", raw);
    // The merchant Stripe account isn't activated for live charges yet. This is
    // an account-state issue, not something the customer can act on — show a
    // calm, non-alarming message instead of Stripe's raw "your account…" text.
    const notActivated = /cannot currently make live charges|account.*not.*activated/i.test(raw);
    const message = notActivated
      ? "Card payments are temporarily unavailable. Please try a wallet top-up, or check back shortly."
      : "Could not start checkout. Please try again.";
    return err(message, "payment_error", 502);
  }
}
