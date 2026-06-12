"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "./account";
import { TopUpControl } from "./TopUpControl";

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Header auth control (Phase E). Two rails, no env gate:
 *  - signed-out → a popover to connect a self-custody wallet OR sign in with an
 *    email (for the card rail);
 *  - signed-in → the active identity (wallet address or email) + credit +
 *    TopUpControl + sign out.
 * Talks only to {@link useAccount}.
 */
export function AuthMenu() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (account.status === "connecting") {
    return <span className="text-xs text-muted font-mono">connecting…</span>;
  }

  // ── Signed in ───────────────────────────────────────────────────────────────
  if (account.status === "signed-in" && account.identity) {
    const label =
      account.identity.kind === "wallet" && account.walletAddress
        ? truncate(account.walletAddress)
        : (account.email ?? "signed in");
    return (
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="font-mono">{label}</span>
          {account.credit != null && (
            <span className="text-emerald-600/90 dark:text-emerald-200/80">· ${account.credit.toFixed(3)}</span>
          )}
        </button>
        {open && (
          <div className="glass glass-menu absolute right-0 mt-2 w-64 rounded-2xl p-3 z-30 text-sm">
            <div className="relative">
              <div className="text-muted text-xs">
                {account.identity.kind === "wallet" ? "Wallet connected" : "Signed in"}
              </div>
              <div className="mt-1 font-mono text-xs text-muted break-all">{account.identity.id}</div>
              <div className="mt-3 flex items-center justify-between rounded-lg bg-[color-mix(in_oklab,var(--ink)_7%,transparent)] px-3 py-2">
                <span className="text-xs text-muted">Credit</span>
                <span className="font-mono text-sm text-emerald-600 dark:text-emerald-300">
                  {account.credit != null ? `$${account.credit.toFixed(3)}` : "—"}
                </span>
              </div>
              <TopUpControl />
              <button
                onClick={() => {
                  setOpen(false);
                  if (account.identity?.kind === "wallet") void account.disconnectWallet();
                  else account.signOutEmail();
                }}
                className="glass-btn mt-3 w-full rounded-lg px-3 py-1.5 text-xs text-ink"
              >
                {account.identity.kind === "wallet" ? "Disconnect" : "Sign out"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Signed out — connect wallet OR sign in with email ───────────────────────
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-semibold bg-gradient-to-br from-accent to-accent-2 text-white shadow-sm hover:opacity-90 transition-opacity"
      >
        Add credit
      </button>
      {open && (
        <div className="glass glass-menu absolute right-0 mt-2 w-72 rounded-2xl p-4 z-30">
          <div className="relative">
            <div className="text-sm text-ink font-medium">Connect a wallet</div>
            <div className="text-xs text-muted mt-0.5">Pay with USDC — you keep custody.</div>
            <div className="mt-2 flex flex-col gap-1.5">
              {account.connectors.length === 0 && (
                <div className="text-xs text-muted-2">No wallet detected in this browser.</div>
              )}
              {account.connectors.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={async () => {
                    setBusy(true);
                    await account.connectWallet(c.id);
                    setBusy(false);
                  }}
                  disabled={busy}
                  className="glass-btn rounded-lg px-3 py-2 text-sm text-ink text-left disabled:opacity-50"
                >
                  {c.name}
                </button>
              ))}
            </div>

            <div className="mt-4 mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-2">
              <span className="h-px flex-1 bg-line" /> or pay by card <span className="h-px flex-1 bg-line" />
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!email.trim()) return;
                account.signInEmail(email.trim());
                setEmail("");
              }}
            >
              <div className="text-xs text-muted mt-0.5">
                Sign in with email, then pay by card — no crypto needed.
              </div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-2 w-full rounded-lg bg-surface-2 border border-line px-3 py-2 text-sm text-ink placeholder-muted-2 outline-none focus:border-accent transition-colors"
              />
              {account.error && (
                <div className="mt-2 text-xs text-rose-500 dark:text-rose-400">{account.error}</div>
              )}
              <button
                type="submit"
                disabled={!email.trim()}
                className="mt-2 w-full rounded-lg bg-gradient-to-br from-accent to-accent-2 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Continue with email
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
