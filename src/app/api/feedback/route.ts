import { submitFeedback } from "@/lib/feedback";
import type { FeedbackRating } from "@/lib/types";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).traceId !== "string" ||
    !(["up", "down"] as const).includes(
      (body as Record<string, unknown>).rating as FeedbackRating,
    )
  ) {
    return Response.json(
      {
        ok: false,
        error:
          'body must be { traceId: string, rating: "up" | "down" }',
      },
      { status: 400 },
    );
  }

  const { traceId, rating } = body as { traceId: string; rating: FeedbackRating };

  const result = await submitFeedback(traceId, rating);

  if (result.ok) {
    return Response.json({ ok: true });
  }

  return Response.json(
    { ok: false, error: result.reason },
    { status: 404 },
  );
}
