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
    <footer className="flex items-center gap-4 h-7 px-3 shrink-0 border-t border-zinc-800 bg-zinc-950 text-[11px] font-mono text-zinc-500 select-none">
      {/* Connection */}
      <span className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`}
        />
        {connected ? "live" : "offline"}
      </span>

      {/* Network */}
      {network && <span className="text-zinc-600">{network}</span>}

      {/* Terminals open */}
      <span className="text-zinc-600">
        {paneCount} terminal{paneCount !== 1 ? "s" : ""}
      </span>

      {/* Session budget bar */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-zinc-400 tabular-nums whitespace-nowrap">
          {fmt(sessionSpent)} / ${sessionBudget.toFixed(2)}
        </span>
        <div className="h-1 w-24 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Latest charge ticker */}
      {latest && (
        <span className="hidden lg:flex items-center gap-1.5 min-w-0 text-zinc-600">
          last:
          <span className="text-zinc-400 truncate max-w-[160px]">{latest.model}</span>
          <span className="text-emerald-400">{fmt(latest.usdcCharged)}</span>
        </span>
      )}

      <div className="flex-1" />

      {/* Feed toggle */}
      <button
        onClick={onToggleFeed}
        className={`flex items-center gap-1.5 px-2 h-full transition-colors ${
          feedOpen ? "text-violet-300 bg-violet-500/10" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        ⛓ spend feed
        {eventCount > 0 && (
          <span className="text-[10px] bg-zinc-800 rounded px-1 text-zinc-400">{eventCount}</span>
        )}
      </button>
    </footer>
  );
}
