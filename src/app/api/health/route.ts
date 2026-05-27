import { getConfig } from "@/lib/config";

export async function GET() {
  const cfg = getConfig();
  return Response.json({
    ok: true,
    providerMode: cfg.providerMode,
    network: cfg.network,
    sessionBudgetUsd: cfg.sessionBudgetUsd,
    facilitator: cfg.facilitatorUrl,
  });
}
