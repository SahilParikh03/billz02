import { getConfig } from "@/lib/config";
import { assessReadiness } from "@/lib/readiness";

/**
 * GET /api/readiness — mainnet readiness probe.
 *
 * Reports whether a live mainnet request could settle right now (`liveReady`),
 * plus hard `blockers` and soft `warnings`. Exposes only presence/shape of
 * secrets, never their values. Returns 200 when liveReady, 503 otherwise, so
 * uptime checks and deploy gates can key off the status code.
 */
export async function GET() {
  const cfg = getConfig();
  const report = await assessReadiness(cfg);
  return Response.json(report, { status: report.liveReady ? 200 : 503 });
}
