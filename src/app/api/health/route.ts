import { getConfig } from "@/lib/config";
import { getStore, isSharedStore } from "@/lib/store";

export async function GET() {
  const cfg = getConfig();
  const store = getStore();
  return Response.json({
    ok: true,
    providerMode: cfg.providerMode,
    network: cfg.network,
    sessionBudgetUsd: cfg.sessionBudgetUsd,
    walletProvider: "key",
    facilitator: { kind: "local", rpc: process.env.BEAMR_RPC_URL || "(chain default)" },
    store: { id: store.id, shared: isSharedStore(store) },
  });
}
