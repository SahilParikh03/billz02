"use client";

import type { SpendEvent } from "./useSpendFeed";

interface StatusBarProps {
  connected: boolean;
  sessionSpent: number;
  sessionBudget: number;
  network?: string;
  eventCount: number;
  paneCount: number;
  latest?: SpendEvent;
  feedOpen: boolean;
  onToggleFeed: () => void;
}

function fmt(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  return `$${amount.toFixed(4)}`;
}

export function StatusBar({
  connected,
  sessionSpent,
  sessionBudget,
  network,
  eventCount,
  paneCount,
  latest,
  feedOpen,
  onToggleFeed,
}: StatusBarProps) {
  const pct = sessionBudget > 0 ? Math.min((sessionSpent / sessionBudget) * 100, 100) : 0;
  const barColor = pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <footer className="glass-bar flex items-center gap-4 h-7 px-3.5 shrink-0 border-t border-line text-[11px] font-mono text-muted select-none">
      {/* Connection */}
      <span className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-faint"}`}
        />
        {connected ? "live" : "offline"}
      </span>

      {/* Network */}
      {network && <span className="text-muted-2">{network}</span>}

      {/* Terminals open */}
      <span className="text-muted-2">
        {paneCount} terminal{paneCount !== 1 ? "s" : ""}
      </span>

      {/* Session budget bar */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted tabular-nums whitespace-nowrap">
          {fmt(sessionSpent)} / ${sessionBudget.toFixed(2)}
        </span>
        <div className="h-1 w-24 rounded-full bg-[color-mix(in_oklab,var(--ink)_12%,transparent)] overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Latest charge ticker */}
      {latest && (
        <span className="hidden lg:flex items-center gap-1.5 min-w-0 text-muted-2">
          last:
          <span className="text-muted truncate max-w-[160px]">{latest.model}</span>
          <span className="text-emerald-600 dark:text-emerald-400">{fmt(latest.usdcCharged)}</span>
        </span>
      )}

      <div className="flex-1" />

      {/* Feed toggle */}
      <button
        onClick={onToggleFeed}
        className={`flex items-center gap-1.5 px-2.5 h-full transition-colors ${
          feedOpen ? "text-accent bg-accent/10" : "text-muted hover:text-ink"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M9 13l-2 2a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M15 11l2-2a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        spend feed
        {eventCount > 0 && (
          <span className="text-[10px] bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] rounded px-1 text-muted">
            {eventCount}
          </span>
        )}
      </button>
    </footer>
  );
}
