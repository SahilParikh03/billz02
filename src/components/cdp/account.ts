"use client";

import { createContext, useContext } from "react";

/**
 * App-level account state, abstracted over the CDP embedded-wallet SDK.
 *
 * The rest of the UI only ever talks to this context (via {@link useAccount}),
 * never to the CDP hooks directly — so the app works identically whether CDP is
 * configured (real email signup) or not (anonymous/disabled mode). The CDP hooks
 * are isolated in `CdpAccountSync`, which is only mounted when a project id is set.
 */

export type AccountStatus =
  | "disabled" // no CDP project id → anonymous mode
  | "loading" // CDP SDK still initializing
  | "signed-out"
  | "otp-pending" // email submitted, awaiting the one-time code
  | "signed-in";

export interface Account {
  /** True when CDP is configured (email signup is available). */
  enabled: boolean;
  status: AccountStatus;
  /** Embedded-wallet EVM address when signed in; also the X-Billz-User id. */
  address: string | null;
  /** Email the user signed in with (for display). */
  email: string | null;
  /** Remaining welcome credit in USD; null until known. */
  credit: number | null;
  /** Last auth error, if any. */
  error: string | null;
  /** Step 1: send the OTP email. Resolves once the code has been dispatched. */
  signIn: (email: string) => Promise<void>;
  /** Step 2: verify the OTP. Resolves once signed in. */
  verifyOtp: (otp: string) => Promise<void>;
  /** Abandon an in-progress OTP flow, back to signed-out. */
  cancel: () => void;
  signOut: () => Promise<void>;
  /** Re-fetch the welcome-credit balance from the server. */
  refreshCredit: () => Promise<void>;
}

const noop = async () => {};

/** Anonymous account: CDP not configured. All auth actions are inert. */
export const ANON_ACCOUNT: Account = {
  enabled: false,
  status: "disabled",
  address: null,
  email: null,
  credit: null,
  error: null,
  signIn: noop,
  verifyOtp: noop,
  cancel: () => {},
  signOut: noop,
  refreshCredit: noop,
};

export const AccountContext = createContext<Account>(ANON_ACCOUNT);

export function useAccount(): Account {
  return useContext(AccountContext);
}
