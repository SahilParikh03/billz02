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
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-800/70 text-zinc-400 border border-zinc-700"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
        Guest
      </span>
    );
  }

  if (account.status === "loading") {
    return <span className="text-xs text-zinc-500 font-mono">…</span>;
  }

  // ── Signed in ───────────────────────────────────────────────────────────────
  if (account.status === "signed-in" && account.address) {
    return (
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="font-mono">{truncate(account.address)}</span>
          {account.credit != null && (
            <span className="text-emerald-200/80">· ${account.credit.toFixed(3)}</span>
          )}
        </button>
        {open && (
          <div className="absolute right-0 mt-2 w-64 rounded-xl bg-zinc-900 border border-zinc-700 shadow-xl p-3 z-30 text-sm">
            <div className="text-zinc-400 text-xs">Signed in</div>
            {account.email && <div className="text-zinc-200 truncate">{account.email}</div>}
            <div className="mt-2 font-mono text-xs text-zinc-400 break-all">{account.address}</div>
            <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-800/60 px-3 py-2">
              <span className="text-xs text-zinc-400">Test credit</span>
              <span className="font-mono text-sm text-emerald-300">
                {account.credit != null ? `$${account.credit.toFixed(3)}` : "—"}
              </span>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                void account.signOut();
              }}
              className="mt-3 w-full rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Sign out
            </button>
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
        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gradient-to-r from-violet-500 to-blue-600 text-white hover:opacity-90 transition-opacity"
      >
        Sign in
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 rounded-xl bg-zinc-900 border border-zinc-700 shadow-xl p-4 z-30">
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
              <div className="text-sm text-zinc-200 font-medium">Enter the code</div>
              <div className="text-xs text-zinc-500 mt-0.5">
                Sent to {account.email ?? "your email"}
              </div>
              <input
                autoFocus
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="6-digit code"
                className="mt-3 w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 font-mono tracking-widest focus:outline-none focus:border-violet-500"
              />
              {account.error && (
                <div className="mt-2 text-xs text-rose-400">{account.error}</div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy || !otp.trim()}
                  className="flex-1 rounded-lg bg-gradient-to-r from-violet-500 to-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? "Verifying…" : "Verify"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    account.cancel();
                    setOtp("");
                  }}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
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
              <div className="text-sm text-zinc-200 font-medium">Sign up with email</div>
              <div className="text-xs text-zinc-500 mt-0.5">
                We create a wallet for you and add free test credit — no seed phrase.
              </div>
              <input
                autoFocus
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-3 w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-violet-500"
              />
              {account.error && (
                <div className="mt-2 text-xs text-rose-400">{account.error}</div>
              )}
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="mt-3 w-full rounded-lg bg-gradient-to-r from-violet-500 to-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Sending…" : "Continue"}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
