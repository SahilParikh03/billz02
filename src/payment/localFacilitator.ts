/**
 * In-process x402 facilitator (Phase E — de-Coinbase).
 *
 * Replaces the hosted Coinbase / public `x402.org` facilitator with a
 * self-contained verify+settle implemented directly against the USDC contract
 * with viem. No Coinbase service is contacted; the only network calls are to the
 * configured RPC (BEAMR_RPC_URL, or the viem chain default).
 *
 *  - verify : reconstruct the EIP-712 `TransferWithAuthorization` from the
 *             requirements, check the signature recovers to `from`, then check
 *             recipient / amount / time-window and the on-chain balance + nonce.
 *             Moves no funds.
 *  - settle : from the router wallet, broadcast
 *             `USDC.transferWithAuthorization(...)` (anyone may broadcast an
 *             EIP-3009 authorization, so the router pays gas and the buyer pays
 *             none), then await the receipt.
 *
 * The `{ verify, settle }` shape mirrors x402's own facilitator client so
 * `payment/seller.ts` consumes it unchanged.
 */

import { getAddress, parseSignature, type Address, type Hex } from "viem";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "x402/types";
import type { AppConfig } from "@/lib/types";
import { chainFor, getPublicClient, getWalletClient } from "./wallet";

export interface LocalFacilitator {
  verify(
    payload: PaymentPayload,
    reqs: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settle(
    payload: PaymentPayload,
    reqs: PaymentRequirements,
  ): Promise<SettleResponse>;
}

// ── EIP-712 / ABI constants ───────────────────────────────────────────────────

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Read-only USDC fragments used by verify. */
const usdcReadAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** EIP-3009 transferWithAuthorization, the (v,r,s) overload — the EOA path. */
const transferWithAuthVrsAbi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** A few seconds of safety margin so an authorization can't expire mid-settle. */
const VALID_BEFORE_MARGIN_SECONDS = BigInt(6);

function invalid(invalidReason: VerifyResponse["invalidReason"], payer?: string): VerifyResponse {
  return { isValid: false, invalidReason, payer };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build the in-process facilitator for a config. Cheap to call repeatedly — the
 * underlying viem clients are cached in `payment/wallet.ts`.
 */
export function createLocalFacilitator(cfg: AppConfig): LocalFacilitator {
  async function verify(
    payload: PaymentPayload,
    reqs: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const ev = payload.payload;
    // The "exact" EVM branch carries an `authorization`; the SVM branch doesn't.
    if (!("authorization" in ev)) return invalid("invalid_payload");
    const a = ev.authorization;

    // Scheme / network must match the offer.
    if (payload.scheme !== "exact" || reqs.scheme !== "exact") {
      return invalid("unsupported_scheme", a.from);
    }
    if (payload.network !== reqs.network) return invalid("invalid_network", a.from);

    const chain = chainFor(reqs.network);
    const eip712 = (reqs.extra ?? {}) as { name?: string; version?: string };
    const asset = getAddress(reqs.asset as Address);

    try {
      // (1) Signature recovers to `from`. The PublicClient method also covers
      //     ERC-1271/6492 smart-wallet signatures; for EOAs it recovers locally.
      const publicClient = getPublicClient(cfg);
      const sigOk = await publicClient.verifyTypedData({
        address: getAddress(a.from as Address),
        domain: {
          name: eip712.name,
          version: eip712.version ?? "2",
          chainId: chain.id,
          verifyingContract: asset,
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: getAddress(a.from as Address),
          to: getAddress(a.to as Address),
          value: BigInt(a.value),
          validAfter: BigInt(a.validAfter),
          validBefore: BigInt(a.validBefore),
          nonce: a.nonce as Hex,
        },
        signature: ev.signature as Hex,
      });
      if (!sigOk) return invalid("invalid_exact_evm_payload_signature", a.from);

      // (2) Recipient must be the advertised payTo.
      if (getAddress(a.to as Address) !== getAddress(reqs.payTo as Address)) {
        return invalid("invalid_exact_evm_payload_recipient_mismatch", a.from);
      }

      // (3) Time window (with a small margin so it can't expire during settle).
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (BigInt(a.validBefore) < now + VALID_BEFORE_MARGIN_SECONDS) {
        return invalid("invalid_exact_evm_payload_authorization_valid_before", a.from);
      }
      if (BigInt(a.validAfter) > now) {
        return invalid("invalid_exact_evm_payload_authorization_valid_after", a.from);
      }

      // (4) The authorized value must cover the price.
      if (BigInt(a.value) < BigInt(reqs.maxAmountRequired)) {
        return invalid("invalid_exact_evm_payload_authorization_value", a.from);
      }

      // (5) On-chain: payer holds enough USDC.
      const balance = (await publicClient.readContract({
        address: asset,
        abi: usdcReadAbi,
        functionName: "balanceOf",
        args: [getAddress(a.from as Address)],
      })) as bigint;
      if (balance < BigInt(reqs.maxAmountRequired)) {
        return invalid("insufficient_funds", a.from);
      }

      // (6) On-chain: this authorization nonce hasn't already been used.
      const used = (await publicClient.readContract({
        address: asset,
        abi: usdcReadAbi,
        functionName: "authorizationState",
        args: [getAddress(a.from as Address), a.nonce as Hex],
      })) as boolean;
      if (used) return invalid("duplicate_settlement", a.from);

      return { isValid: true, payer: a.from };
    } catch {
      return invalid("unexpected_verify_error", a.from);
    }
  }

  async function settle(
    payload: PaymentPayload,
    reqs: PaymentRequirements,
  ): Promise<SettleResponse> {
    const ev = payload.payload;
    if (!("authorization" in ev)) {
      return { success: false, errorReason: "invalid_payload", transaction: "", network: payload.network };
    }
    const a = ev.authorization;

    // Re-verify immediately before broadcasting (guards the verify→settle gap).
    const v = await verify(payload, reqs);
    if (!v.isValid) {
      return {
        success: false,
        errorReason: v.invalidReason ?? "invalid_payment",
        transaction: "",
        network: payload.network,
        payer: a.from,
      };
    }

    try {
      const walletClient = getWalletClient(cfg);
      const sig = parseSignature(ev.signature as Hex);
      const vByte = sig.v !== undefined ? Number(sig.v) : 27 + sig.yParity;

      const txHash = await walletClient.writeContract({
        address: getAddress(reqs.asset as Address),
        abi: transferWithAuthVrsAbi,
        functionName: "transferWithAuthorization",
        args: [
          getAddress(a.from as Address),
          getAddress(a.to as Address),
          BigInt(a.value),
          BigInt(a.validAfter),
          BigInt(a.validBefore),
          a.nonce as Hex,
          vByte,
          sig.r,
          sig.s,
        ],
      });

      const receipt = await getPublicClient(cfg).waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        return {
          success: false,
          errorReason: "invalid_transaction_state",
          transaction: txHash,
          network: payload.network,
          payer: a.from,
        };
      }

      return { success: true, transaction: txHash, network: payload.network, payer: a.from };
    } catch {
      return {
        success: false,
        errorReason: "unexpected_settle_error",
        transaction: "",
        network: payload.network as Network,
        payer: a.from,
      };
    }
  }

  return { verify, settle };
}
