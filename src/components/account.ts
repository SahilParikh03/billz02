"use client";

import { createContext, useContext } from "react";
import type { TopUpResult } from "@/payment/topUp";

/**
 * App-level account state, abstracted over the two top-up rails.
 *
 * The rest of the UI only ever talks to this context (via {@link useAccount}),
 * never to wagmi or Stripe directly. There are two ways to become a
 * credit-bearing {@link Identity}:
 *   - connect a self-custody wallet (Rail A) → `{ kind: "wallet", id: 0x… }`,
 *     which can sign x402 top-ups (`topUp`); or
 *   - sign in with an email (Rail B) → `{ kind: "email", id: "email:…" }`, which
 *     funds credit by card (`payByCard`).
 * A connected wallet takes precedence as the active identity.
 */

export type IdentityKind = "wallet" | "email";

export interface Identity {
  kind: IdentityKind;
  /** The credit-ledger key + `X-Beamr-User` value (0x… or email:…). */
  id: string;
}

export type AccountStatus = "signed-out" | "connecting" | "signed-in";

export interface ConnectorInfo {
  id: string;
  name: string;
}

export type { TopUpResult };

export interface Account {
  status: AccountStatus;
  /** The active credit identity (wallet wins over email), or null when neither. */
  identity: Identity | null;
  /** Connected self-custody wallet address, if any (Rail A). */
  walletAddress: string | null;
  /** Email the user signed in with, if any (Rail B). */
  email: string | null;
  /** Remaining credit in USD; null until known. */
  credit: number | null;
  /** Last error, if any. */
  error: string | null;
  /** Wallet connectors available to offer (injected / WalletConnect / Coinbase). */
  connectors: ConnectorInfo[];
  /** Connect a self-custody wallet. Pass a connector id, or omit for the first. */
  connectWallet: (connectorId?: string) => Promise<void>;
  disconnectWallet: () => Promise<void>;
  /** Sign in with an email → an `email:<lowercased>` identity (persisted). */
  signInEmail: (email: string) => void;
  /** Forget the email identity. */
  signOutEmail: () => void;
  /** Re-fetch the credit balance for the active identity. */
  refreshCredit: () => Promise<void>;
  /**
   * Wallet rail: pay `amountUsd` of USDC from the connected wallet over x402 and
   * credit the settled amount. Errors out when no wallet is connected.
   */
  topUp: (amountUsd: number) => Promise<TopUpResult>;
  /**
   * Card rail: open Stripe Checkout for `amountUsd` against the active identity.
   * Resolves after redirecting (or with an error if the session can't start).
   */
  payByCard: (amountUsd: number) => Promise<{ ok: boolean; error?: string }>;
}

const noop = async () => {};

/** Inert default — used before any provider mounts. */
export const ANON_ACCOUNT: Account = {
  status: "signed-out",
  identity: null,
  walletAddress: null,
  email: null,
  credit: null,
  error: null,
  connectors: [],
  connectWallet: noop,
  disconnectWallet: noop,
  signInEmail: () => {},
  signOutEmail: () => {},
  refreshCredit: noop,
  topUp: async () => ({ ok: false, error: "connect a wallet to add credit" }),
  payByCard: async () => ({ ok: false, error: "sign in to pay by card" }),
};

export const AccountContext = createContext<Account>(ANON_ACCOUNT);

export function useAccount(): Account {
  return useContext(AccountContext);
}
