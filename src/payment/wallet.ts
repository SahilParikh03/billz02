import type { Signer } from "x402/types";
import { createSigner } from "x402-fetch";
import type { AppConfig } from "@/lib/types";

// ── Provider selection ──────────────────────────────────────────────────────

/**
 * Reads BILLZ_WALLET_PROVIDER from the environment and returns the normalised
 * provider name. Defaults to "key" when the variable is absent or empty.
 *
 * Values:
 *  "key"  – raw private-key signer via x402-fetch's createSigner (default)
 *  "cdp"  – Coinbase Developer Platform Server Wallets (MPC + spend caps)
 *           STUB: requires @coinbase/cdp-sdk which is not yet installed.
 */
export function walletProvider(): "key" | "cdp" {
  const raw = process.env.BILLZ_WALLET_PROVIDER ?? "";
  if (raw === "cdp") return "cdp";
  return "key";
}

// ── Module-level signer cache (key provider only) ───────────────────────────

/**
 * Signer cache keyed by private-key string.
 *
 * A signer creation performs an EVM account derivation and connects to an RPC.
 * Caching means one derivation per unique private key per process lifetime,
 * rather than one per request.
 */
const signerCache = new Map<string, Signer>();

// ── getSigner ────────────────────────────────────────────────────────────────

/**
 * Returns the x402 Signer for the given config, dispatching on
 * BILLZ_WALLET_PROVIDER (default "key").
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

// ── "cdp" provider (STUB) ────────────────────────────────────────────────────

/**
 * CDP Server Wallet provider — STUB.
 *
 * Coinbase Developer Platform Server Wallets offer MPC-based key custody with
 * enforced spend caps, making them appropriate for mainnet hot-wallet use in
 * serverless environments (no plaintext private key at rest).
 *
 * Intended integration (NOT yet implemented):
 * -----------------------------------------------------------------------
 * 1. Install the SDK:
 *      npm install @coinbase/cdp-sdk
 *
 * 2. Set environment variables:
 *      CDP_API_KEY_ID        – CDP API key ID (from Coinbase Developer Portal)
 *      CDP_API_KEY_SECRET    – CDP API key secret / private key PEM
 *      CDP_WALLET_ID         – (optional) pre-created wallet ID to reuse across
 *                              cold starts; if absent, create one on first boot
 *                              and persist the returned wallet.id.
 *
 * 3. Adapt the CDP account to the x402 Signer interface:
 *      import { CdpClient } from "@coinbase/cdp-sdk";
 *      const cdp = new CdpClient({ apiKeyId, apiKeySecret });
 *      const account = walletId
 *        ? await cdp.evm.getAccount({ walletId })
 *        : await cdp.evm.createAccount();
 *      // Wrap `account` so it satisfies the x402 Signer (SignerWallet) shape —
 *      // both expose signMessage / signTypedData / sendTransaction.
 *
 * See: https://docs.cdp.coinbase.com/cdp-sdk/docs/welcome
 * -----------------------------------------------------------------------
 *
 * @throws Error always — CDP SDK is not yet installed.
 */
async function getSignerCdp(): Promise<Signer> {
  throw new Error(
    "payment/wallet.getSigner [provider=cdp]: CDP Server Wallets are not yet " +
      "configured. To enable:\n" +
      "  1. npm install @coinbase/cdp-sdk\n" +
      "  2. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET in .env.local\n" +
      "  3. Optionally set CDP_WALLET_ID to reuse an existing server wallet\n" +
      "See the comment block in src/payment/wallet.ts for the full integration sketch.",
  );
}

// ── getX402Config — NOT provided ─────────────────────────────────────────────
//
// x402's X402Config type (from "x402/types") only contains:
//   { svmConfig?: { rpcUrl?: string } }
//
// There is no EVM RPC URL field — EVM RPC selection is baked into createSigner
// via viem's chain config, not via X402Config. Providing a getX402Config helper
// that forwards BILLZ_RPC_URL would therefore be a no-op for EVM networks.
// Wiring it in for SVM is out of scope here; skip to avoid misleading callers.
