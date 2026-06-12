/**
 * Account / welcome-credit endpoint.
 *
 * POST /api/account  { address }  — called right after sign-in (a connected
 *   self-custody wallet `0x…` or an `email:<id>` identity). Idempotently grants
 *   the one-time welcome test credit to that id and returns its credit status.
 *   Safe to call on every sign-in.
 *
 * GET /api/account?user=…          — current credit status for a wallet or email id.
 *
 * Credit gating applies only to signed-in (credit-bearing) users; anonymous
 * session users keep the per-session budget and never touch this endpoint.
 */

import { getConfig } from "@/lib/config";
import { creditStatus, grantWelcomeCredit, isCreditUser } from "@/lib/credit";

function badRequest(message: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error" } },
    { status: 400 },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: { address?: string };
  try {
    body = (await request.json()) as { address?: string };
  } catch {
    return badRequest("invalid JSON body");
  }

  const address = body.address?.trim();
  if (!isCreditUser(address)) {
    return badRequest("address must be a 0x-prefixed EVM wallet address or an email:<id>");
  }

  const welcome = getConfig().welcomeCreditUsd ?? 1;
  const status = await grantWelcomeCredit(address!, welcome);
  return Response.json(status);
}

export async function GET(request: Request): Promise<Response> {
  const user = new URL(request.url).searchParams.get("user")?.trim();
  if (!isCreditUser(user)) {
    return badRequest("user query param must be a 0x-prefixed EVM wallet address or an email:<id>");
  }
  return Response.json(await creditStatus(user!));
}
