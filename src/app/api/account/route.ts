/**
 * Account / welcome-credit endpoint.
 *
 * POST /api/account  { address }  — called right after a CDP embedded-wallet
 *   sign-in. Idempotently grants the one-time welcome test credit to that wallet
 *   and returns its credit status. Safe to call on every sign-in.
 *
 * GET /api/account?user=0x…       — current credit status for a wallet.
 *
 * Credit gating applies only to wallet-identified (signed-in) users; anonymous
 * session users keep the per-session budget and never touch this endpoint.
 */

import { getConfig } from "@/lib/config";
import { creditStatus, grantWelcomeCredit, isWalletUser } from "@/lib/credit";

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
  if (!isWalletUser(address)) {
    return badRequest("address must be a 0x-prefixed EVM wallet address");
  }

  const welcome = getConfig().welcomeCreditUsd ?? 1;
  const status = await grantWelcomeCredit(address!, welcome);
  return Response.json(status);
}

export async function GET(request: Request): Promise<Response> {
  const user = new URL(request.url).searchParams.get("user")?.trim();
  if (!isWalletUser(user)) {
    return badRequest("user query param must be a 0x-prefixed EVM wallet address");
  }
  return Response.json(await creditStatus(user!));
}
