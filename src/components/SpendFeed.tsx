"use client";

import { useEffect, useRef, useState } from "react";
import { SpendEvent } from "./useSpendFeed";

function formatUsdc(amount: number): string {
  if (amount === 0) return "$0.000000";
  if (amount < 0.001) return `$${amount.toFixed(6)}`;
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  return `$${amount.toFixed(4)}`;
}

function ProviderBadge({ provider }: { provider: string }) {
  const styles: Record<string, string> = {
    venice: "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/25",
    hyperbolic: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/25",
    mock: "bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] text-muted border-line",
  };
  const style = styles[provider] ?? "bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] text-muted border-line";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border uppercase tracking-wide ${style}`}
    >
      {provider}
    </span>
  );
}

function PaymentModeBadge({ mode }: { mode: string }) {
  if (mode === "x402-percall") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M9 13l-2 2a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M15 11l2-2a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        x402
      </span>
    );
  }
  if (mode === "credit-balance") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" stroke="currentColor" strokeWidth="2" />
          <path d="M2.5 9.5h19" stroke="currentColor" strokeWidth="2" />
        </svg>
        credit
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] text-muted border border-line">
      mock
    </span>
  );
}

/** Block-explorer base URL for the active network (mainnet vs. Sepolia testnet). */
function explorerBaseFor(network?: string): string {
  return network === "base"
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";
}

function SpendEventCard({
  event,
  isNew,
  explorerBase,
}: {
  event: SpendEvent;
  isNew: boolean;
  explorerBase: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger animation after mount
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const time = new Date(event.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div
      className={`rounded-xl border bg-surface/70 p-3 transition-all duration-300 ${
        isNew && !visible
          ? "opacity-0 -translate-y-1"
          : "opacity-100 translate-y-0"
      } ${isNew ? "border-accent/40" : "border-line"}`}
    >
      {/* Top row: provider + model + amount */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <ProviderBadge provider={event.provider} />
          <span className="text-xs text-ink font-mono truncate">{event.model}</span>
        </div>
        <span className="text-sm font-mono font-semibold text-emerald-600 dark:text-emerald-400 shrink-0 tabular-nums">
          {formatUsdc(event.usdcCharged)}
        </span>
      </div>

      {/* Middle: tokens + latency */}
      <div className="flex items-center gap-3 text-[11px] text-muted font-mono mb-2">
        {(event.inputTokens != null || event.outputTokens != null) && (
          <span>
            {event.inputTokens ?? "?"} → {event.outputTokens ?? "?"} tok
          </span>
        )}
        <span>{event.latencyMs}ms</span>
        <PaymentModeBadge mode={event.paymentMode} />
        {event.cacheHit && (
          <span className="text-cyan-600 dark:text-cyan-400">cache hit</span>
        )}
      </div>

      {/* Reason */}
      {event.reason && (
        <p className="text-[11px] text-muted-2 leading-tight mb-2 italic truncate">
          {event.reason}
        </p>
      )}

      {/* Bottom: time + tx link */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-faint font-mono">{time}</span>
        {event.settlementTxHash && (
          <a
            href={`${explorerBase}/tx/${event.settlementTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-600 dark:text-blue-400 hover:opacity-80 font-mono flex items-center gap-1 transition-opacity"
          >
            {event.settlementTxHash.slice(0, 8)}…
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5.5 1.5H8.5V4.5M8.5 1.5L4 6M2.5 2.5H1.5V8.5H7.5V7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}

interface SpendFeedProps {
  events: SpendEvent[];
  sessionSpent: number;
  sessionBudget: number;
  connected: boolean;
  network?: string;
}

export function SpendFeed({ events, sessionSpent, sessionBudget, connected, network }: SpendFeedProps) {
  const explorerBase = explorerBaseFor(network);
  const seenIds = useRef<Set<string>>(new Set());
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  // Track newly arrived events for animation
  useEffect(() => {
    const fresh = events.filter((e) => !seenIds.current.has(e.traceId));
    if (fresh.length === 0) return;
    const freshIds = new Set(fresh.map((e) => e.traceId));
    fresh.forEach((e) => seenIds.current.add(e.traceId));
    setNewIds(freshIds);
    const t = setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev);
        freshIds.forEach((id) => next.delete(id));
        return next;
      });
    }, 2000);
    return () => clearTimeout(t);
  }, [events]);

  const pct = sessionBudget > 0 ? Math.min((sessionSpent / sessionBudget) * 100, 100) : 0;
  const barColor =
    pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-sm font-semibold text-ink">Live spend feed</span>
            <span
              className={`w-2 h-2 rounded-full ${
                connected ? "bg-emerald-400 animate-pulse" : "bg-faint"
              }`}
            />
          </div>
          <span className="text-xs text-muted font-mono">
            {events.length} event{events.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Budget progress */}
        <div>
          <div className="flex justify-between text-xs font-mono mb-1.5">
            <span className="text-muted">Session spent</span>
            <span className="text-ink tabular-nums">
              {formatUsdc(sessionSpent)} / ${sessionBudget.toFixed(2)}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-[color-mix(in_oklab,var(--ink)_12%,transparent)] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {pct > 85 && (
            <p className="text-[11px] text-red-500 dark:text-red-400 mt-1">Approaching budget limit</p>
          )}
        </div>
      </div>

      {/* Events list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 scrollbar-thin">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
            <div className="glass w-11 h-11 rounded-xl flex items-center justify-center text-muted">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M3 7.5h18v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-11Z" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3 7.5 6 4h12l3 3.5M12 12.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <p className="text-muted text-sm">No charges yet</p>
              <p className="text-muted-2 text-xs mt-1">
                Charges appear here as you chat
              </p>
            </div>
          </div>
        ) : (
          events.map((event) => (
            <SpendEventCard
              key={event.traceId}
              event={event}
              isNew={newIds.has(event.traceId)}
              explorerBase={explorerBase}
            />
          ))
        )}
      </div>
    </div>
  );
}
