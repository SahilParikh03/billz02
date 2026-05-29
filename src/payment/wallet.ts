import type { Signer } from "x402/types";
import { createSigner } from "x402-fetch";
import type { AppConfig } from "@/lib/types";

/** Default name for the CDP server account BEAMR creates/reuses across cold starts. */
const CDP_WALLET_NAME = process.env.CDP_WALLET_NAME || "beamr-router";

// ── Provider selection ──────────────────────────────────────────────────────

/**
 * Reads BEAMR_WALLET_PROVIDER from the environment and returns the normalised
 * provider name. Defaults to "key" when the variable is absent or empty.
 *
 * Values:
 *  "key"  – raw private-key signer via x402-fetch's createSigner (default)
 *  "cdp"  – Coinbase Developer Platform Server Wallets (MPC + spend caps)
 *           STUB: requires @coinbase/cdp-sdk which is not yet installed.
 */
export function walletProvider(): "key" | "cdp" {
  const raw = process.env.BEAMR_WALLET_PROVIDER ?? "";
  if (raw === "cdp") return "cdp";
  return "key";
}

// ── Module-level signer caches ───────────────────────────────────────────────

/**
 * Signer cache keyed by private-key string.
 *
 * A signer creation performs an EVM account derivation and connects to an RPC.
 * Caching means one derivation per unique private key per process lifetime,
 * rather than one per request.
 */
const signerCache = new Map<string, Signer>();

/**
 * CDP signer cache keyed by account name. A CDP `getOrCreateAccount` is a
 * network round-trip to the CDP API; cache it so each warm instance derives the
 * MPC account once, not per request.
 */
const cdpSignerCache = new Map<string, Signer>();

// ── getSigner ────────────────────────────────────────────────────────────────

/**
 * Returns the x402 Signer for the given config, dispatching on
 * BEAMR_WALLET_PROVIDER (default "key").
 *
 * Guards:
 * - Must never be called in mock mode (the mock adapter does no settlement).
 * - Each provider path validates its own prerequisites before doing any work.
 *
 * Supported networks for the "key" provider: any network string accepted by
 * x402-fetch's createSigner, including "base-sepolia" and "base" (mainnet).
 * No mapping is required — createSigner(network: string, privateKey) takes the
 * network literal directly.
 *
 * @throws Error if called in mock mode or when the active provider lacks its
 *         required prerequisites (private key / CDP credentials).
 */
export async function getSigner(cfg: AppConfig): Promise<Signer> {
  if (cfg.providerMode === "mock") {
    throw new Error(
      "payment/wallet.getSigner: called in mock mode — no wallet needed for mock providers",
    );
  }

  const provider = walletProvider();

  if (provider === "cdp") {
    return getSignerCdp();
  }

  // Default: "key" provider
  return getSignerKey(cfg);
}

// ── "key" provider ───────────────────────────────────────────────────────────

/**
 * Private-key provider: wraps x402-fetch's createSigner with a module-level
 * cache. Works for both "base-sepolia" (testnet) and "base" (mainnet).
 */
async function getSignerKey(cfg: AppConfig): Promise<Signer> {
  if (!cfg.walletPrivateKey) {
    throw new Error(
      "payment/wallet.getSigner [provider=key]: WALLET_PRIVATE_KEY is not set. " +
        "Generate a wallet and add the 0x-prefixed private key to .env.local.",
    );
  }

  const pk = cfg.walletPrivateKey;
  const cached = signerCache.get(pk);
  if (cached) return cached;

  const signer = await createSigner(cfg.network, pk);
  signerCache.set(pk, signer);
  return signer;
}

// ── "cdp" provider ───────────────────────────────────────────────────────────

/** True when all three CDP secrets are present in the environment. */
export function cdpCredsPresent(): boolean {
  return Boolean(
    process.env.CDP_API_KEY_ID &&
      process.env.CDP_API_KEY_SECRET &&
      process.env.CDP_WALLET_SECRET,
  );
}

/**
 * CDP Server Wallet provider.
 *
 * Coinbase Developer Platform Server Wallets hold keys via MPC (no plaintext
 * private key at rest), which is the recommended posture for a mainnet hot
 * wallet running in stateless serverless functions. The returned
 * `EvmServerAccount` exposes `address` / `signMessage` / `signTypedData`, which
 * is exactly the surface x402's `EvmSigner` (= `SignerWallet | LocalAccount`)
 * uses to sign the EIP-3009 `transferWithAuthorization` for the `exact` scheme.
 *
 * Credentials (from portal.cdp.coinbase.com → API keys / wallet secret):
 *   CDP_API_KEY_ID, CDP_API_KEY_SECRET  – authenticate the whole CDP API.
 *   CDP_WALLET_SECRET                   – authorizes signing/transaction calls.
 *   CDP_WALLET_NAME (optional)          – reused across cold starts so the same
 *                                         funded account is loaded every time.
 *
 * The CdpClient reads the three secrets straight from the environment; we never
 * hold them in AppConfig. `getOrCreateAccount` is idempotent on the name, so a
 * fresh deploy reuses the existing funded account rather than stranding funds.
 *
 * @throws Error if the CDP credentials are not fully configured.
 */
async function getSignerCdp(): Promise<Signer> {
  if (!cdpCredsPresent()) {
    throw new Error(
      "payment/wallet.getSigner [provider=cdp]: CDP Server Wallet credentials " +
        "are not fully configured. Set all three in .env.local:\n" +
        "  CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET\n" +
        "Create them at portal.cdp.coinbase.com (API key + wallet secret). " +
        "Optionally set CDP_WALLET_NAME to reuse a named account across deploys.",
    );
  }

  const name = CDP_WALLET_NAME;
  const cached = cdpSignerCache.get(name);
  if (cached) return cached;

  // Lazy import: only pull in the CDP SDK on the CDP path so the default "key"
  // path (and tests) never load it.
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  // CdpClient reads CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET from env.
  const cdp = new CdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name });

  // The EvmServerAccount satisfies x402's EvmSigner surface (a viem-style
  // account with signTypedData/signMessage/address). The structural types
  // differ only in viem's `type: "local"` discriminant, so cast through unknown.
  const signer = account as unknown as Signer;
  cdpSignerCache.set(name, signer);
  return signer;
}

/** Clear the CDP signer cache — for tests. */
export function resetCdpSignerCache(): void {
  cdpSignerCache.clear();
}

// ── getX402Config — NOT provided ─────────────────────────────────────────────
//
// x402's X402Config type (from "x402/types") only contains:
//   { svmConfig?: { rpcUrl?: string } }
//
// There is no EVM RPC URL field — EVM RPC selection is baked into createSigner
// via viem's chain config, not via X402Config. Providing a getX402Config helper
// that forwards BEAMR_RPC_URL would therefore be a no-op for EVM networks.
// Wiring it in for SVM is out of scope here; skip to avoid misleading callers.
