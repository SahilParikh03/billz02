import { getConfig } from "@/lib/config";
import { facilitatorKind, facilitatorUrl } from "@/payment/facilitator";
import { walletProvider } from "@/payment/wallet";
import { getStore, isSharedStore } from "@/lib/store";

export async function GET() {
  const cfg = getConfig();
  const store = getStore();
  return Response.json({
    ok: true,
    providerMode: cfg.providerMode,
    network: cfg.network,
    sessionBudgetUsd: cfg.sessionBudgetUsd,
    walletProvider: walletProvider(),
    facilitator: { kind: facilitatorKind(), url: facilitatorUrl(cfg) },
    store: { id: store.id, shared: isSharedStore(store) },
  });
}
