/**
 * CDP embedded wallet → x402 signer adapter (Phase D spike).
 *
 * x402's exact-scheme client (`createPaymentHeader` in `x402/client`) signs an
 * EIP-3009 `TransferWithAuthorization` by calling `signTypedData(data)` on a
 * wallet that satisfies x402's `isAccount` check, and reads `.address` for the
 * `from` field. The browser CDP embedded wallet doesn't expose a viem account —
 * only the `useSignEvmTypedData()` hook — so this adapts the hook's
 * `signEvmTypedData` into the minimal account shape x402 accepts.
 *
 * Why a hand-built object instead of viem's `toAccount`: x402's `isAccount`
 * requires `sign`/`signMessage`/`signTypedData`/`signTransaction` to all be
 * functions and `type` to be a string. The exact scheme only ever *calls*
 * `signTypedData` and reads `address`, so the other three exist solely to pass
 * the type guard and throw if anything unexpectedly invokes them.
 *
 * The one real adaptation: x402 hands `signTypedData` a `data` whose `types`
 * omit the `EIP712Domain` entry (viem infers it). CDP's `signEvmTypedData`
 * requires it explicitly, so we synthesize it from the domain's present fields.
 *
 * This module is isomorphic (pure, no CDP/React imports — the signer is injected)
 * so it runs in the browser and is unit-testable in Node.
 */

import { getAddress } from "viem";

/** The shape `@coinbase/cdp-hooks` `useSignEvmTypedData().signEvmTypedData` exposes. */
export type SignEvmTypedData = (opts: {
  evmAccount: string;
  typedData: Record<string, unknown>;
}) => Promise<{ signature: string }>;

/** The EIP-712 typed-data object x402 passes to `signTypedData`. */
interface TypedData {
  types: Record<string, { name: string; type: string }[]>;
  domain: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Build the canonical `EIP712Domain` type entry from whichever domain fields are
 * present, in the standard order. USDC uses name/version/chainId/verifyingContract.
 */
function eip712DomainType(
  domain: Record<string, unknown>,
): { name: string; type: string }[] {
  const fields: { key: string; type: string }[] = [
    { key: "name", type: "string" },
    { key: "version", type: "string" },
    { key: "chainId", type: "uint256" },
    { key: "verifyingContract", type: "address" },
    { key: "salt", type: "bytes32" },
  ];
  return fields
    .filter((f) => domain[f.key] != null)
    .map((f) => ({ name: f.key, type: f.type }));
}

/** A minimal viem-`Account`-shaped object that x402's `isAccount` accepts. */
export interface X402Account {
  address: `0x${string}`;
  type: "local";
  signTypedData: (data: TypedData) => Promise<string>;
  sign: () => Promise<never>;
  signMessage: () => Promise<never>;
  signTransaction: () => Promise<never>;
}

/**
 * Adapt a CDP embedded wallet into an x402-compatible signer.
 *
 * @param address  the user's embedded-wallet address (`useEvmAddress()`)
 * @param signEvmTypedData  `useSignEvmTypedData().signEvmTypedData`
 */
export function cdpX402Account(
  address: string,
  signEvmTypedData: SignEvmTypedData,
): X402Account {
  const notSupported = (method: string) => async (): Promise<never> => {
    throw new Error(
      `cdpX402Account: ${method} is not supported — the x402 exact scheme only signs typed data`,
    );
  };

  return {
    address: getAddress(address),
    type: "local",
    sign: notSupported("sign"),
    signMessage: notSupported("signMessage"),
    signTransaction: notSupported("signTransaction"),
    async signTypedData(data: TypedData): Promise<string> {
      // Inject the EIP712Domain entry CDP requires but x402 omits.
      const typedData = {
        ...data,
        types: { EIP712Domain: eip712DomainType(data.domain), ...data.types },
      };
      const { signature } = await signEvmTypedData({
        evmAccount: getAddress(address),
        typedData,
      });
      return signature;
    },
  };
}
