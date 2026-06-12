/**
 * OpenAI-compatible chat completions endpoint.
 *
 * POST /api/v1/chat/completions
 *
 * Accepts a ChatCompletionRequest (with optional `stream` flag).
 * - stream (default true): returns text/event-stream SSE, OpenAI chunk format.
 * - stream: false: buffers and returns a JSON ChatCompletion object.
 *
 * Session tracking: body.session_id || X-Beamr-Session header || generated id.
 * Budget exceeded: 402 JSON response BEFORE the stream starts.
 */

import { getConfig, resolveSell } from "@/lib/config";
import { newId } from "@/lib/ids";
import type { AppConfig, ChatCompletionRequest } from "@/lib/types";
import { isCreditUser } from "@/lib/credit";
import { executeChat } from "@/pipeline/execute";
import { priceQuote } from "@/payment/quote";
import {
  buildPaymentRequirements,
  decodePaymentHeader,
  paymentRequiredBody,
  settlePayment,
  verifyPayment,
} from "@/payment/seller";
import type { PaymentPayload, PaymentRequirements } from "x402/types";
import type { LocalFacilitator } from "@/payment/localFacilitator";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Pipeline errors that mean "out of money" → surfaced as HTTP 402. */
const BUDGET_ERRORS = new Set([
  "session budget exceeded",
  "insufficient credit — top up",
]);

/** Context threaded from the pre-work verify to the post-work settle. */
interface SettleContext {
  payload: PaymentPayload;
  reqs: PaymentRequirements;
  facilitator: LocalFacilitator;
}

/**
 * Seller-side x402 paywall preflight (Phase 1, non-streaming only).
 *
 * Returns:
 *  - a `Response` to short-circuit POST (402 unpaid / 400 / 500 misconfig), or
 *  - a `SettleContext` when the buyer's payment verified and work may proceed, or
 *  - `null` when the paywall is disabled (free path; unchanged behavior).
 *
 * Settlement is intentionally deferred to AFTER the completion succeeds.
 */
async function preflightPaywall(
  cfg: AppConfig,
  body: ChatCompletionRequest,
  request: Request,
  sessionId: string,
): Promise<Response | SettleContext | null> {
  const sell = resolveSell(cfg);
  if (!sell.enabled) return null;

  const errHeaders = { "X-Beamr-Session": sessionId };

  // Phase 1 only meters the buffered, non-streaming path (streaming paid access
  // is the credit-balance model in a later phase).
  if (body.stream !== false) {
    return Response.json(
      {
        error: {
          message: "paid access requires stream:false in this phase",
          type: "invalid_request_error",
        },
      },
      { status: 400, headers: errHeaders },
    );
  }
  if (!sell.payTo) {
    return Response.json(
      {
        error: {
          message: "seller misconfigured: BEAMR_SELL_PAY_TO is unset",
          type: "server_error",
        },
      },
      { status: 500, headers: errHeaders },
    );
  }

  const quote = priceQuote(body.messages ?? [], cfg);
  const reqs = buildPaymentRequirements(cfg, {
    atomicUsdc: quote.atomicUsdc,
    resource: new URL(request.url).pathname,
    description: `BEAMR inference (${quote.tier} tier)`,
  });

  const payload = decodePaymentHeader(request.headers.get("x-payment"));
  if (!payload) {
    return Response.json(paymentRequiredBody(reqs, "payment required"), {
      status: 402,
      headers: errHeaders,
    });
  }

  const verdict = await verifyPayment(cfg, payload, reqs);
  if (!verdict.ok || !verdict.facilitator) {
    return Response.json(
      paymentRequiredBody(reqs, `payment invalid: ${verdict.reason ?? "unknown"}`),
      { status: 402, headers: errHeaders },
    );
  }

  return { payload, reqs, facilitator: verdict.facilitator };
}

export async function POST(request: Request): Promise<Response> {
  let body: ChatCompletionRequest;
  try {
    body = (await request.json()) as ChatCompletionRequest;
  } catch {
    return Response.json(
      { error: { message: "invalid JSON body", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  const cfg = getConfig();
  const sessionId =
    body.session_id ||
    request.headers.get("x-beamr-session") ||
    newId("sess");
  const userId = request.headers.get("x-beamr-user") || sessionId;
  const policyMode = request.headers.get("x-beamr-policy");
  const traceId = newId("trace");
  const requestId = newId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);

  // ── Lane selection by caller identity ───────────────────────────────────────
  // Signed-in credit-bearing users (wallet or email) pay from their prepaid
  // credit balance: streaming is allowed and the cost-plus charge happens in the
  // pipeline, so they bypass the x402 machine paywall (and its non-streaming-only
  // guard). The pipeline still enforces a sufficient balance and returns 402 "top
  // up" when short. Anonymous / agent callers go through the x402 preflight (no-op
  // unless BEAMR_SELL_ENABLED).
  const creditLane = isCreditUser(userId);
  const gate = creditLane
    ? null
    : await preflightPaywall(cfg, body, request, sessionId);
  if (gate instanceof Response) return gate;
  const settleCtx: SettleContext | null = gate;

  // ── Non-streaming mode ─────────────────────────────────────────────────────
  if (body.stream === false) {
    let content = "";
    let model = body.model ?? "auto";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const event of executeChat(cfg, body, {
      sessionId,
      userId,
      policyMode,
      traceId,
      signal: request.signal,
    })) {
      if (event.type === "delta") {
        content += event.content;
      } else if (event.type === "done") {
        model = event.result.model;
        inputTokens = event.result.inputTokens;
        outputTokens = event.result.outputTokens;
      } else if (event.type === "error") {
        const isBudget = BUDGET_ERRORS.has(event.error);
        const status = isBudget ? 402 : 500;
        const type = isBudget ? "budget_exceeded" : "provider_error";
        return Response.json(
          { error: { message: event.error, type } },
          {
            status,
            headers: { "X-Beamr-Session": sessionId },
          },
        );
      }
    }

    const headers: Record<string, string> = {
      "X-Beamr-Session": sessionId,
      "X-Beamr-Trace": traceId,
    };

    // Settle only on the success path — the completion was produced, so move
    // the exact authorized amount and attach the receipt. A settlement failure
    // here is rare (the payment already verified) but we surface it as 402
    // rather than handing back unpaid output.
    if (settleCtx) {
      const settled = await settlePayment(
        settleCtx.facilitator,
        settleCtx.payload,
        settleCtx.reqs,
      );
      if (!settled.success) {
        return Response.json(
          {
            error: {
              message: `settlement failed: ${settled.error ?? "unknown"}`,
              type: "payment_error",
            },
          },
          { status: 402, headers: { "X-Beamr-Session": sessionId } },
        );
      }
      if (settled.header) headers["X-PAYMENT-RESPONSE"] = settled.header;
    }

    return Response.json(
      {
        id: requestId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: inputTokens ?? 0,
          completion_tokens: outputTokens ?? 0,
          total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
        },
      },
      { headers },
    );
  }

  // ── Streaming mode (default) ───────────────────────────────────────────────
  // Peek the first event to detect a budget error before committing to a stream
  // response (once we return 200 + stream, we cannot change the status code).
  const it = executeChat(cfg, body, {
    sessionId,
    userId,
    policyMode,
    traceId,
    signal: request.signal,
  })[Symbol.asyncIterator]();

  const first = await it.next();
  if (!first.done && first.value.type === "error") {
    const ev = first.value;
    const isBudget = BUDGET_ERRORS.has(ev.error);
    return Response.json(
      {
        error: {
          message: ev.error,
          type: isBudget ? "budget_exceeded" : "provider_error",
        },
      },
      {
        status: isBudget ? 402 : 500,
        headers: { "X-Beamr-Session": sessionId },
      },
    );
  }

  // The first event was not an error; build the stream.
  const encoder = new TextEncoder();

  function sseChunk(content: string): string {
    return (
      `data: ${JSON.stringify({
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model: body.model ?? "auto",
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      })}\n\n`
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (text: string) =>
        controller.enqueue(encoder.encode(text));

      try {
        // Drain the first event we already read.
        if (!first.done) {
          const ev = first.value;
          if (ev.type === "delta") {
            enqueue(sseChunk(ev.content));
          } else if (ev.type === "done") {
            // Rare: provider returned done immediately (no deltas).
            enqueue(
              `data: ${JSON.stringify({
                id: requestId,
                object: "chat.completion.chunk",
                created,
                model: ev.result.model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
            );
            enqueue("data: [DONE]\n\n");
            controller.close();
            return;
          }
        }

        // Continue draining the rest of the iterator.
        for await (const event of { [Symbol.asyncIterator]: () => it }) {
          if (request.signal?.aborted) break;

          if (event.type === "delta") {
            enqueue(sseChunk(event.content));
          } else if (event.type === "done") {
            // Final chunk with finish_reason.
            enqueue(
              `data: ${JSON.stringify({
                id: requestId,
                object: "chat.completion.chunk",
                created,
                model: event.result.model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
            );
            enqueue("data: [DONE]\n\n");
            controller.close();
            return;
          } else if (event.type === "error") {
            // Mid-stream error — best we can do is send an error SSE chunk.
            enqueue(
              `data: ${JSON.stringify({ error: { message: event.error } })}\n\n`,
            );
            enqueue("data: [DONE]\n\n");
            controller.close();
            return;
          }
        }
      } catch {
        controller.close();
      } finally {
        // Ensure stream is always closed.
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...SSE_HEADERS,
      "X-Beamr-Session": sessionId,
      "X-Beamr-Trace": traceId,
    },
  });
}
