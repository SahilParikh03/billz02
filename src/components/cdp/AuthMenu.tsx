"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "./account";

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Header auth control. Renders the right thing for each account status:
 * disabled (anonymous), signed-out (email form), otp-pending (code form),
 * signed-in (address + credit + sign out). Talks only to {@link useAccount}.
 */
export function AuthMenu() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
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

  // ── Anonymous (CDP not configured) ──────────────────────────────────────────
  if (!account.enabled) {
    return (
      <span
        title="Email signup is available once NEXT_PUBLIC_CDP_PROJECT_ID is set"
        className="glass-btn inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-muted"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-faint" />
        Guest
      </span>
    );
  }

  if (account.status === "loading") {
    return <span className="text-xs text-muted font-mono">…</span>;
  }

  // ── Signed in ───────────────────────────────────────────────────────────────
  if (account.status === "signed-in" && account.address) {
    return (
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="font-mono">{truncate(account.address)}</span>
          {account.credit != null && (
            <span className="text-emerald-600/90 dark:text-emerald-200/80">· ${account.credit.toFixed(3)}</span>
          )}
        </button>
        {open && (
          <div className="glass absolute right-0 mt-2 w-64 rounded-2xl p-3 z-30 text-sm">
            <div className="relative">
              <div className="text-muted text-xs">Signed in</div>
              {account.email && <div className="text-ink truncate">{account.email}</div>}
              <div className="mt-2 font-mono text-xs text-muted break-all">{account.address}</div>
              <div className="mt-3 flex items-center justify-between rounded-lg bg-[color-mix(in_oklab,var(--ink)_7%,transparent)] px-3 py-2">
                <span className="text-xs text-muted">Test credit</span>
                <span className="font-mono text-sm text-emerald-600 dark:text-emerald-300">
                  {account.credit != null ? `$${account.credit.toFixed(3)}` : "—"}
                </span>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  void account.signOut();
                }}
                className="glass-btn mt-3 w-full rounded-lg px-3 py-1.5 text-xs text-ink"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Signed out / OTP-pending (email signup flow) ────────────────────────────
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-semibold bg-gradient-to-br from-accent to-accent-2 text-white shadow-sm hover:opacity-90 transition-opacity"
      >
        Sign in
      </button>
      {open && (
        <div className="glass absolute right-0 mt-2 w-72 rounded-2xl p-4 z-30"><div className="relative">
          {account.status === "otp-pending" ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!otp.trim() || busy) return;
                setBusy(true);
                await account.verifyOtp(otp.trim());
                setBusy(false);
                setOtp("");
              }}
            >
              <div className="text-sm text-ink font-medium">Enter the code</div>
              <div className="text-xs text-muted mt-0.5">
                Sent to {account.email ?? "your email"}
              </div>
              <input
                autoFocus
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="6-digit code"
                className="mt-3 w-full rounded-lg bg-surface-2 border border-line px-3 py-2 text-sm text-ink placeholder-muted-2 font-mono tracking-widest outline-none focus:border-accent transition-colors"
              />
              {account.error && (
                <div className="mt-2 text-xs text-rose-500 dark:text-rose-400">{account.error}</div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy || !otp.trim()}
                  className="flex-1 rounded-lg bg-gradient-to-br from-accent to-accent-2 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? "Verifying…" : "Verify"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    account.cancel();
                    setOtp("");
                  }}
                  className="glass-btn rounded-lg px-3 py-2 text-sm text-muted hover:text-ink"
                >
                  Back
                </button>
              </div>
            </form>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!email.trim() || busy) return;
                setBusy(true);
                await account.signIn(email.trim());
                setBusy(false);
              }}
            >
              <div className="text-sm text-ink font-medium">Sign up with email</div>
              <div className="text-xs text-muted mt-0.5">
                We create a wallet for you and add free test credit — no seed phrase.
              </div>
              <input
                autoFocus
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-3 w-full rounded-lg bg-surface-2 border border-line px-3 py-2 text-sm text-ink placeholder-muted-2 outline-none focus:border-accent transition-colors"
              />
              {account.error && (
                <div className="mt-2 text-xs text-rose-500 dark:text-rose-400">{account.error}</div>
              )}
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="mt-3 w-full rounded-lg bg-gradient-to-br from-accent to-accent-2 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Sending…" : "Continue"}
              </button>
            </form>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
