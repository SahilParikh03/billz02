"use client";

import { useState } from "react";
import { useAccount } from "./account";

const PRESETS = [1, 5, 20];

/**
 * "Add credit" control for the signed-in account popover (Phase E).
 *
 * Routes by identity: a connected wallet pays USDC over x402 (`topUp`); an email
 * identity goes to Stripe Checkout (`payByCard`, which redirects). Shows
 * in-flight / success / error states. Pure UI over the account context.
 */
export function TopUpControl() {
  const account = useAccount();
  const isWallet = account.identity?.kind === "wallet";
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<{ credited?: number; txHash?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = busy != null;

  async function add(amount: number) {
    if (inFlight) return;
    setBusy(amount);
    setError(null);
    setDone(null);
    if (isWallet) {
      const result = await account.topUp(amount);
      setBusy(null);
      if (result.ok) setDone({ credited: result.credited, txHash: result.txHash });
      else setError(result.error ?? "Top-up failed. Try again.");
    } else {
      // Card rail: this redirects to Stripe on success; only errors return here.
      const result = await account.payByCard(amount);
      setBusy(null);
      if (!result.ok) setError(result.error ?? "Could not start checkout. Try again.");
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Add credit</span>
        <span className="text-[10px] text-muted-2">{isWallet ? "pay with USDC" : "pay by card"}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {PRESETS.map((amount) => (
          <button
            key={amount}
            type="button"
            disabled={inFlight}
            onClick={() => void add(amount)}
            className="glass-btn flex-1 rounded-lg px-2 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
          >
            {busy === amount ? "…" : `$${amount}`}
          </button>
        ))}
      </div>
      {inFlight && (
        <div className="mt-2 text-xs text-muted">
          {isWallet ? "Signing & settling on-chain…" : "Opening secure checkout…"}
        </div>
      )}
      {done && !inFlight && (
        <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-300">
          Added ${done.credited?.toFixed(2) ?? "credit"}.
          {done.txHash && (
            <>
              {" "}
              <span className="font-mono text-emerald-700/70 dark:text-emerald-200/60">
                {done.txHash.slice(0, 10)}…
              </span>
            </>
          )}
        </div>
      )}
      {error && !inFlight && (
        <div className="mt-2 text-xs text-rose-500 dark:text-rose-400">{error}</div>
      )}
    </div>
  );
}
