/**
 * SSE spend feed.
 *
 * GET /api/feed
 *
 * On connect: replays the last 100 SpendEvents, then pushes each new event
 * as it arrives. Sends `: keepalive` comments every 15 s. Cleans up on
 * client disconnect (request.signal abort).
 */

import { recentSpend, subscribeSpend } from "@/lib/events";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      function enqueue(text: string) {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // controller may already be closed
          }
        }
      }

      function close() {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }

      // Replay recent events.
      for (const event of recentSpend()) {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      }

      // Subscribe to new events.
      const unsubscribe = subscribeSpend((event) => {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Keepalive every 15 s.
      const keepalive = setInterval(() => {
        enqueue(": keepalive\n\n");
      }, 15_000);

      // Cleanup on client disconnect.
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(keepalive);
        close();
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
