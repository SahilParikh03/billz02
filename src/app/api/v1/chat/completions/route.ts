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

import { getConfig } from "@/lib/config";
import { newId } from "@/lib/ids";
import type { ChatCompletionRequest } from "@/lib/types";
import { executeChat } from "@/pipeline/execute";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Pipeline errors that mean "out of money" → surfaced as HTTP 402. */
const BUDGET_ERRORS = new Set(["session budget exceeded", "credit exhausted"]);

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
      {
        headers: { "X-Beamr-Session": sessionId, "X-Beamr-Trace": traceId },
      },
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
