"use client";

import { useState } from "react";
import { useAccount } from "./account";

const PRESETS = [1, 5, 20];

/**
 * "Add credit" control for the signed-in account popover.
 *
 * Pick an amount → {@link useAccount}.topUp pays USDC from the embedded wallet
 * over x402 and credits the settled amount. Shows in-flight, success (with the
 * settlement tx), and error states. Pure UI over the account context — no CDP or
 * x402 imports here; all of that lives behind `topUp`.
 */
export function TopUpControl() {
  const account = useAccount();
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<{ credited?: number; txHash?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = busy != null;

  async function add(amount: number) {
    if (inFlight) return;
    setBusy(amount);
    setError(null);
    setDone(null);
    const result = await account.topUp(amount);
    setBusy(null);
    if (result.ok) setDone({ credited: result.credited, txHash: result.txHash });
    else setError(result.error ?? "Top-up failed. Try again.");
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Add credit</span>
        <span className="text-[10px] text-muted-2">pay with USDC</span>
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
        <div className="mt-2 text-xs text-muted">Signing &amp; settling on-chain…</div>
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
