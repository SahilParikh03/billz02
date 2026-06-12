/**
 * Stripe webhook — grant credit after a card payment settles (Phase E, Rail B).
 *
 * POST /api/credit/stripe/webhook
 *
 * Stripe calls this after a Checkout Session is paid. On
 * `checkout.session.completed` we read `metadata.userId` + `amount_total` and
 * add that to the user's credit balance — the funding side of the card rail,
 * mirroring what the x402 top-up does for wallets. This is the ONLY place a card
 * payment becomes credit (the checkout route just starts the session).
 *
 * Two correctness requirements:
 *  1. Authenticity — verify the Stripe signature against the RAW request body.
 *     Per the Next.js route-handler docs, `await request.text()` yields the raw
 *     body directly (no `bodyParser` config needed); we must not JSON-parse
 *     before verifying or the signature check breaks.
 *  2. Idempotency — Stripe retries deliveries, so each event id is credited at
 *     most once, guarded by a `stripe:evt:<id>` marker in the shared store.
 */

import Stripe from "stripe";
import { addCredit, isCreditUser } from "@/lib/credit";
import { getStore } from "@/lib/store";

// Signature verification uses node crypto over the raw body — needs the Node
// runtime (and the raw body, not a parsed one).
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !webhookSecret) {
    return new Response("Stripe webhook is not configured", { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("missing stripe-signature header", { status: 400 });
  }

  // RAW body — required for signature verification. Do NOT parse first.
  const rawBody = await request.text();
  const stripe = new Stripe(secret);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (e) {
    return new Response(`Webhook signature verification failed: ${(e as Error).message}`, {
      status: 400,
    });
  }

  // Idempotency: mark the event seen before acting, so a replayed delivery is a
  // no-op rather than a double credit.
  const store = getStore();
  const dedupeKey = `stripe:evt:${event.id}`;
  if (await store.get(dedupeKey)) {
    return Response.json({ received: true, deduped: true });
  }
  await store.set(dedupeKey, "1");

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const amountTotal = session.amount_total; // smallest currency unit (cents)
    if (isCreditUser(userId) && typeof amountTotal === "number" && amountTotal > 0) {
      await addCredit(userId!, amountTotal / 100);
    }
  }

  return Response.json({ received: true });
}
