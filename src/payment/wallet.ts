import type { Signer } from "x402/types";
import { createSigner } from "x402-fetch";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "@/lib/types";

/**
 * Router wallet + viem clients.
 *
 * BEAMR uses one funded "router" wallet (WALLET_PRIVATE_KEY) for two jobs:
 *  1. As the *buyer* — `getSigner` builds the x402-fetch signer that signs the
 *     EIP-3009 authorizations BEAMR sends when it pays upstream providers
 *     (Hyperbolic / Surplus).
 *  2. As the *settler* — `getWalletClient` builds a viem WalletClient that
 *     broadcasts `transferWithAuthorization` for the in-process facilitator
 *     (`payment/localFacilitator.ts`), so the buyer never pays gas.
 *
 * There is no Coinbase service here any more: the CDP server-wallet provider was
 * removed in Phase E (de-Coinbase). The only provider is the raw private key.
 */

// ── Module-level caches ──────────────────────────────────────────────────────

/**
 * Signer cache keyed by private-key string. createSigner derives an EVM account
 * and connects to an RPC; cache it so that happens once per key per process.
 */
const signerCache = new Map<string, Signer>();

// Inner builders — their inferred return types are the *specific* viem client
// types (with chain/account bound), so `.writeContract` doesn't demand account/
// chain args and `.account.address` is known. Caches reuse those exact types.
function buildPublicClient(cfg: AppConfig) {
  return createPublicClient({ chain: chainFor(cfg.network), transport: http(rpcUrl()) });
}
function buildWalletClient(cfg: AppConfig & { walletPrivateKey: Hex }) {
  return createWalletClient({
    account: privateKeyToAccount(cfg.walletPrivateKey),
    chain: chainFor(cfg.network),
    transport: http(rpcUrl()),
  });
}

type RouterPublicClient = ReturnType<typeof buildPublicClient>;
type RouterWalletClient = ReturnType<typeof buildWalletClient>;

/** viem client caches, keyed by the inputs that change identity (network/rpc/key). */
const publicClientCache = new Map<string, RouterPublicClient>();
const walletClientCache = new Map<string, RouterWalletClient>();

// ── Chain / RPC selection ────────────────────────────────────────────────────

/** Map the BEAMR_NETWORK string to a viem chain. */
export function chainFor(network: string): Chain {
  return network === "base" ? base : baseSepolia;
}

/** The configured RPC URL, or undefined to use the viem chain's default. */
function rpcUrl(): string | undefined {
  return process.env.BEAMR_RPC_URL || undefined;
}

// ── getSigner (buyer side) ────────────────────────────────────────────────────

/**
 * Returns the x402 Signer for the router wallet — used when BEAMR is the *buyer*
 * (paying upstream x402 providers). Backed by x402-fetch's createSigner with a
 * module-level cache. Works for both "base-sepolia" and "base".
 *
 * @throws Error if called in mock mode or when WALLET_PRIVATE_KEY is unset.
 */
export async function getSigner(cfg: AppConfig): Promise<Signer> {
  if (cfg.providerMode === "mock") {
    throw new Error(
      "payment/wallet.getSigner: called in mock mode — no wallet needed for mock providers",
    );
  }
  if (!cfg.walletPrivateKey) {
    throw new Error(
      "payment/wallet.getSigner: WALLET_PRIVATE_KEY is not set. " +
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

// ── viem clients (settler side) ───────────────────────────────────────────────

/**
 * A read-only viem PublicClient for the configured network. Used by the
 * in-process facilitator for `verifyTypedData`, `balanceOf`, `authorizationState`,
 * and `waitForTransactionReceipt`. Needs no private key.
 */
export function getPublicClient(cfg: AppConfig): RouterPublicClient {
  const key = `${cfg.network}:${rpcUrl() ?? ""}`;
  const cached = publicClientCache.get(key);
  if (cached) return cached;
  const client = buildPublicClient(cfg);
  publicClientCache.set(key, client);
  return client;
}

/**
 * A viem WalletClient bound to the router account (WALLET_PRIVATE_KEY). Used by
 * the in-process facilitator to broadcast `transferWithAuthorization` — the
 * router pays gas, the buyer pays none.
 *
 * @throws Error if called in mock mode or when WALLET_PRIVATE_KEY is unset.
 */
export function getWalletClient(cfg: AppConfig): RouterWalletClient {
  if (cfg.providerMode === "mock") {
    throw new Error(
      "payment/wallet.getWalletClient: called in mock mode — no settlement happens for mock providers",
    );
  }
  if (!cfg.walletPrivateKey) {
    throw new Error(
      "payment/wallet.getWalletClient: WALLET_PRIVATE_KEY is not set. " +
        "Set the 0x-prefixed router private key in .env.local to settle in-process.",
    );
  }
  const pk = cfg.walletPrivateKey;
  const key = `${cfg.network}:${pk}:${rpcUrl() ?? ""}`;
  const cached = walletClientCache.get(key);
  if (cached) return cached;
  const client = buildWalletClient({ ...cfg, walletPrivateKey: pk });
  walletClientCache.set(key, client);
  return client;
}
