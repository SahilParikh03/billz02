"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useIsInitialized,
  useIsSignedIn,
  useEvmAddress,
  useSignInWithEmail,
  useVerifyEmailOTP,
  useSignOut,
  useSignEvmTypedData,
} from "@coinbase/cdp-hooks";
import { AccountContext, type Account, type AccountStatus, type TopUpResult } from "./account";
import { runTopUp } from "./topUp";
import type { SignEvmTypedData } from "@/payment/cdpSigner";

/** Extract a human-ish message from an unknown thrown value. */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Bridges the CDP embedded-wallet hooks onto our AccountContext, and manages the
 * two-step email→OTP flow. Mounted only inside CDPHooksProvider, so the CDP
 * hooks are always called (never conditionally).
 */
export function CdpAccountSync({ children }: { children: React.ReactNode }) {
  const { isInitialized } = useIsInitialized();
  const { isSignedIn } = useIsSignedIn();
  const { evmAddress } = useEvmAddress();
  const { signInWithEmail } = useSignInWithEmail();
  const { verifyEmailOTP } = useVerifyEmailOTP();
  const { signOut } = useSignOut();
  const { signEvmTypedData } = useSignEvmTypedData();

  const [flowId, setFlowId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [credit, setCredit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const address = evmAddress ?? null;

  const status: AccountStatus = !isInitialized
    ? "loading"
    : isSignedIn && address
      ? "signed-in"
      : flowId
        ? "otp-pending"
        : "signed-out";

  const refreshCredit = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`/api/account?user=${address}`);
      if (res.ok) {
        const data = (await res.json()) as { balance?: number };
        if (typeof data.balance === "number") setCredit(data.balance);
      }
    } catch {
      // non-fatal: leave the last known credit value
    }
  }, [address]);

  // On sign-in, idempotently grant the welcome credit and read the balance.
  useEffect(() => {
    if (!isSignedIn || !address) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address }),
        });
        if (res.ok && !cancelled) {
          const data = (await res.json()) as { balance?: number };
          if (typeof data.balance === "number") setCredit(data.balance);
        }
      } catch {
        // non-fatal — chat still works, credit just won't display
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, address]);

  const signIn = useCallback(
    async (emailInput: string) => {
      setError(null);
      try {
        const { flowId: id } = await signInWithEmail({ email: emailInput });
        setFlowId(id);
        setEmail(emailInput);
      } catch (e) {
        setError(errMsg(e, "Could not send the sign-in email. Try again."));
      }
    },
    [signInWithEmail],
  );

  const verifyOtp = useCallback(
    async (otp: string) => {
      if (!flowId) return;
      setError(null);
      try {
        await verifyEmailOTP({ flowId, otp });
        setFlowId(null); // isSignedIn + evmAddress flip via the SDK
      } catch (e) {
        setError(errMsg(e, "Invalid or expired code. Try again."));
      }
    },
    [flowId, verifyEmailOTP],
  );

  const topUp = useCallback(
    async (amountUsd: number): Promise<TopUpResult> => {
      if (!address) return { ok: false, error: "sign in to add credit" };
      // The CDP hook's signEvmTypedData is structurally compatible with the
      // adapter's signer; cast at this single SDK seam (branded EvmAddress/Hex).
      const result = await runTopUp(
        address,
        signEvmTypedData as unknown as SignEvmTypedData,
        amountUsd,
      );
      if (result.ok && typeof result.balance === "number") setCredit(result.balance);
      return result;
    },
    [address, signEvmTypedData],
  );

  const cancel = useCallback(() => {
    setFlowId(null);
    setError(null);
  }, []);

  const doSignOut = useCallback(async () => {
    try {
      await signOut();
    } finally {
      setFlowId(null);
      setEmail(null);
      setCredit(null);
      setError(null);
    }
  }, [signOut]);

  const value = useMemo<Account>(
    () => ({
      enabled: true,
      status,
      address,
      email,
      credit,
      error,
      signIn,
      verifyOtp,
      cancel,
      signOut: doSignOut,
      refreshCredit,
      topUp,
    }),
    [status, address, email, credit, error, signIn, verifyOtp, cancel, doSignOut, refreshCredit, topUp],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
