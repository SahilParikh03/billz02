/**
 * Rail-agnostic x402 signer adapter (Phase E).
 *
 * x402's exact-scheme client (`createPaymentHeader` in `x402/client`) signs an
 * EIP-3009 `TransferWithAuthorization` by calling `signTypedData(data)` on a
 * wallet that satisfies x402's `isAccount` check, and reads `.address` for the
 * `from` field. This adapts ANY `signTypedData(typedData) => signature` function
 * (e.g. wagmi's `useSignTypedData().signTypedDataAsync`) into that minimal
 * account shape.
 *
 * Unlike the old CDP adapter, this does NOT inject an `EIP712Domain` entry into
 * `types`: viem/wagmi infer it from `domain`, and adding it ourselves would
 * double-define the type and break the hash. The injection was a CDP-only quirk.
 *
 * Pure (no React/wallet imports — the signer is injected), so it runs in the
 * browser and is unit-testable in Node against the real x402 encoder.
 */

import { getAddress } from "viem";

/** The EIP-712 typed-data object x402 passes to `signTypedData`. */
export interface TypedData {
  types: Record<string, { name: string; type: string }[]>;
  domain: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** A `signTypedData` function — e.g. wagmi's `signTypedDataAsync`. */
export type SignTypedDataFn = (data: TypedData) => Promise<string>;

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
 * Adapt a self-custody wallet into an x402-compatible signer.
 *
 * @param address  the connected wallet address
 * @param signTypedData  signs an EIP-712 payload and returns the signature
 *                       (pass the typed data straight through — no EIP712Domain
 *                       fix-up; viem infers it)
 */
export function x402Account(
  address: string,
  signTypedData: SignTypedDataFn,
): X402Account {
  const notSupported = (method: string) => async (): Promise<never> => {
    throw new Error(
      `x402Account: ${method} is not supported — the x402 exact scheme only signs typed data`,
    );
  };

  return {
    address: getAddress(address),
    type: "local",
    sign: notSupported("sign"),
    signMessage: notSupported("signMessage"),
    signTransaction: notSupported("signTransaction"),
    signTypedData: (data: TypedData) => signTypedData(data),
  };
}
