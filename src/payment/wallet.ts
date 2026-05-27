import type { Signer } from "x402/types";
import { createSigner } from "x402-fetch";
import type { AppConfig } from "@/lib/types";

/**
 * Module-level signer cache keyed by private key string.
 *
 * A signer is an async-created object that performs an EVM account derivation.
 * Caching means one derivation per unique private key per process lifetime,
 * rather than one per request.
 */
const signerCache = new Map<string, Signer>();

/**
 * Returns the x402 Signer for the given config, creating it once and caching it.
 *
 * Guards:
 * - Must never be called in mock mode (the mock adapter does no settlement).
 * - Must never be called without a wallet private key.
 *
 * @throws Error if called in mock mode or with a missing private key.
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
