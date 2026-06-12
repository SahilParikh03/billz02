/**
 * Mainnet readiness assessment.
 *
 * Answers one operational question: "if BEAMR took a real mainnet request right
 * now, would it settle — and what's risky about the current config?" It inspects
 * the live environment (provider mode, wallet provider + creds, facilitator,
 * shared store reachability) and returns a report with hard `blockers` (which
 * gate `liveReady`) and soft `warnings` (advisory, e.g. mainnet without a shared
 * store or without CDP screening). It never exposes secret values — only whether
 * each is present.
 */

import type { AppConfig } from "./types";
import { getStore, isSharedStore } from "./store";

export interface ReadinessReport {
  providerMode: "mock" | "live";
  network: string;
  mainnet: boolean;
  wallet: { provider: "key"; configured: boolean };
  facilitator: { kind: "local"; rpc: string };
  store: { id: string; shared: boolean; reachable: boolean };
  cache: { enabled: boolean; shared: boolean };
  /** True when a live mainnet request could settle right now (no hard blockers). */
  liveReady: boolean;
  blockers: string[];
  warnings: string[];
}

export async function assessReadiness(cfg: AppConfig): Promise<ReadinessReport> {
  const mainnet = cfg.network === "base";

  // The router wallet (WALLET_PRIVATE_KEY) is the only signer/settler now — it
  // both pays upstream providers and broadcasts in-process settlement.
  const walletConfigured = Boolean(cfg.walletPrivateKey);

  // Shared store reachability.
  const store = getStore();
  const shared = isSharedStore(store);
  const reachable = await store.ping();

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (cfg.providerMode !== "live") {
    blockers.push("BEAMR_PROVIDER_MODE is not 'live' (running in mock mode)");
  }

  if (!walletConfigured) {
    blockers.push("WALLET_PRIVATE_KEY is not set (router wallet signs + settles)");
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
  if (mainnet && !process.env.BEAMR_RPC_URL) {
    warnings.push(
      "no BEAMR_RPC_URL set; in-process settlement falls back to the public chain RPC (rate-limited) — set a dedicated mainnet RPC",
    );
  }
  if (!mainnet && cfg.providerMode === "live") {
    warnings.push(`live mode on testnet '${cfg.network}' — switch BEAMR_NETWORK=base for mainnet`);
  }

  return {
    providerMode: cfg.providerMode,
    network: cfg.network,
    mainnet,
    wallet: { provider: "key", configured: walletConfigured },
    facilitator: { kind: "local", rpc: process.env.BEAMR_RPC_URL || "(chain default)" },
    store: { id: store.id, shared, reachable },
    cache: { enabled: cfg.cache.enabled, shared: cfg.cache.enabled && shared },
    liveReady: blockers.length === 0,
    blockers,
    warnings,
  };
}
