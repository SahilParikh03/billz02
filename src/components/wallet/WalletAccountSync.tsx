"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount as useWagmiAccount,
  useConnect,
  useDisconnect,
  useSignTypedData,
} from "wagmi";
import {
  AccountContext,
  type Account,
  type AccountStatus,
  type Identity,
  type TopUpResult,
} from "../account";
import { x402Account, type SignTypedDataFn } from "@/payment/x402Account";
import { runTopUp } from "@/payment/topUp";

const EMAIL_STORAGE_KEY = "beamr:email";

/** Extract a human-ish message from an unknown thrown value. */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Bridges the wagmi wallet hooks + a lightweight email identity onto our
 * AccountContext. A connected wallet is the active identity (and can sign x402
 * top-ups); otherwise an email identity (`email:<lowercased>`) funds by card.
 * Mounted inside WalletProvider so the wagmi hooks are always called.
 */
export function WalletAccountSync({ children }: { children: React.ReactNode }) {
  const { address, status: wagmiStatus } = useWagmiAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signTypedDataAsync } = useSignTypedData();

  const [email, setEmail] = useState<string | null>(null);
  const [credit, setCredit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Restore a previously-saved email identity once, after mount. Reading
  // localStorage is an external-system sync that can't run during SSR (and must
  // not, to avoid a hydration mismatch), so the post-mount setState is intended.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(EMAIL_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydrate from localStorage
      if (saved) setEmail(saved);
    } catch {
      // localStorage unavailable — email rail just won't persist.
    }
  }, []);

  // A connected wallet wins as the active identity; else the email identity.
  const identity: Identity | null = useMemo(
    () =>
      address
        ? { kind: "wallet", id: address }
        : email
          ? { kind: "email", id: `email:${email}` }
          : null,
    [address, email],
  );
  const identityId = identity?.id ?? null;

  const status: AccountStatus =
    wagmiStatus === "connecting" || wagmiStatus === "reconnecting"
      ? "connecting"
      : identity
        ? "signed-in"
        : "signed-out";

  const refreshCredit = useCallback(async () => {
    if (!identityId) return;
    try {
      const res = await fetch(`/api/account?user=${encodeURIComponent(identityId)}`);
      if (res.ok) {
        const data = (await res.json()) as { balance?: number };
        if (typeof data.balance === "number") setCredit(data.balance);
      }
    } catch {
      // non-fatal: leave the last known credit value
    }
  }, [identityId]);

  // When the active identity appears/changes, idempotently grant the welcome
  // credit and read the balance.
  useEffect(() => {
    if (!identityId) return; // credit is reset by the disconnect / sign-out handlers
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: identityId }),
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
  }, [identityId]);

  const connectWallet = useCallback(
    async (connectorId?: string) => {
      setError(null);
      const connector = connectorId
        ? connectors.find((c) => c.id === connectorId)
        : connectors[0];
      if (!connector) {
        setError("No wallet connector available. Install MetaMask or a browser wallet.");
        return;
      }
      try {
        await connectAsync({ connector });
      } catch (e) {
        setError(errMsg(e, "Could not connect the wallet. Try again."));
      }
    },
    [connectors, connectAsync],
  );

  const disconnectWallet = useCallback(async () => {
    try {
      await disconnectAsync();
      setCredit(null);
    } catch {
      // ignore — UI reflects wagmi state on the next render
    }
  }, [disconnectAsync]);

  const signInEmail = useCallback((input: string) => {
    const normalized = input.trim().toLowerCase();
    if (!normalized) return;
    setEmail(normalized);
    try {
      window.localStorage.setItem(EMAIL_STORAGE_KEY, normalized);
    } catch {
      // non-fatal — identity holds for this session
    }
  }, []);

  const signOutEmail = useCallback(() => {
    setEmail(null);
    setCredit(null);
    try {
      window.localStorage.removeItem(EMAIL_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const topUp = useCallback(
    async (amountUsd: number): Promise<TopUpResult> => {
      if (!address) return { ok: false, error: "connect a wallet to add credit" };
      const signTypedData: SignTypedDataFn = (data) => signTypedDataAsync(data as never);
      const result = await runTopUp(x402Account(address, signTypedData), amountUsd);
      if (result.ok && typeof result.balance === "number") setCredit(result.balance);
      return result;
    },
    [address, signTypedDataAsync],
  );

  const payByCard = useCallback(
    async (amountUsd: number): Promise<{ ok: boolean; error?: string }> => {
      if (!identityId) return { ok: false, error: "sign in to pay by card" };
      try {
        const res = await fetch("/api/credit/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount_usd: amountUsd, userId: identityId }),
        });
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
        if (!res.ok || !data.url) {
          return { ok: false, error: data.error?.message ?? `could not start checkout (${res.status})` };
        }
        window.location.href = data.url;
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errMsg(e, "Could not start checkout. Try again.") };
      }
    },
    [identityId],
  );

  const connectorList = useMemo(
    () => connectors.map((c) => ({ id: c.id, name: c.name })),
    [connectors],
  );

  const value = useMemo<Account>(
    () => ({
      status,
      identity,
      walletAddress: address ?? null,
      email,
      credit,
      error,
      connectors: connectorList,
      connectWallet,
      disconnectWallet,
      signInEmail,
      signOutEmail,
      refreshCredit,
      topUp,
      payByCard,
    }),
    [
      status,
      identity,
      address,
      email,
      credit,
      error,
      connectorList,
      connectWallet,
      disconnectWallet,
      signInEmail,
      signOutEmail,
      refreshCredit,
      topUp,
      payByCard,
    ],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
