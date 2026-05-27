/**
 * Mainnet readiness assessment.
 *
 * Answers one operational question: "if BILLZ took a real mainnet request right
 * now, would it settle — and what's risky about the current config?" It inspects
 * the live environment (provider mode, wallet provider + creds, facilitator,
 * shared store reachability) and returns a report with hard `blockers` (which
 * gate `liveReady`) and soft `warnings` (advisory, e.g. mainnet without a shared
 * store or without CDP screening). It never exposes secret values — only whether
 * each is present.
 */

import type { AppConfig } from "./types";
import { walletProvider, cdpCredsPresent } from "@/payment/wallet";
import { facilitatorKind, facilitatorUrl } from "@/payment/facilitator";
import { getStore, isSharedStore } from "./store";

export interface ReadinessReport {
  providerMode: "mock" | "live";
  network: string;
  mainnet: boolean;
  wallet: { provider: "key" | "cdp"; configured: boolean };
  facilitator: { kind: "cdp" | "public"; url: string };
  store: { id: string; shared: boolean; reachable: boolean };
  cache: { enabled: boolean; shared: boolean };
  /** True when a live mainnet request could settle right now (no hard blockers). */
  liveReady: boolean;
  blockers: string[];
  warnings: string[];
}

export async function assessReadiness(cfg: AppConfig): Promise<ReadinessReport> {
  const mainnet = cfg.network === "base";
  const provider = walletProvider();

  // Wallet configured?
  const walletConfigured =
    provider === "cdp" ? cdpCredsPresent() : Boolean(cfg.walletPrivateKey);

  // Shared store reachability.
  const store = getStore();
  const shared = isSharedStore(store);
  const reachable = await store.ping();

  const facKind = facilitatorKind();

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (cfg.providerMode !== "live") {
    blockers.push("BILLZ_PROVIDER_MODE is not 'live' (running in mock mode)");
  }

  if (!walletConfigured) {
    blockers.push(
      provider === "cdp"
        ? "CDP wallet creds incomplete (need CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET)"
        : "WALLET_PRIVATE_KEY is not set (key wallet provider)",
    );
  }

  if (shared && !reachable) {
    blockers.push(`shared store '${store.id}' is unreachable (check REDIS_URL/REDIS_TOKEN)`);
  }

  // Soft warnings — risky, not fatal.
  if (mainnet && !shared) {
    warnings.push(
      "budget state is process-local; set REDIS_URL/REDIS_TOKEN so per-session/user caps hold across instances",
    );
  }
  if (mainnet && provider === "key") {
    warnings.push(
      "using a raw private-key hot wallet on mainnet; set BILLZ_WALLET_PROVIDER=cdp for MPC custody + spend caps",
    );
  }
  if (mainnet && facKind === "public") {
    warnings.push(
      "using the public facilitator; set CDP_API_KEY_ID/SECRET for the CDP facilitator (OFAC/KYT screening + SLA)",
    );
  }
  if (!mainnet && cfg.providerMode === "live") {
    warnings.push(`live mode on testnet '${cfg.network}' — switch BILLZ_NETWORK=base for mainnet`);
  }

  return {
    providerMode: cfg.providerMode,
    network: cfg.network,
    mainnet,
    wallet: { provider, configured: walletConfigured },
    facilitator: { kind: facKind, url: facilitatorUrl(cfg) },
    store: { id: store.id, shared, reachable },
    cache: { enabled: cfg.cache.enabled, shared: cfg.cache.enabled && shared },
    liveReady: blockers.length === 0,
    blockers,
    warnings,
  };
}
