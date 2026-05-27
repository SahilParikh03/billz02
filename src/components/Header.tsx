"use client";

import { HealthData } from "./useHealth";

interface HeaderProps {
  health: HealthData | null;
}

export function Header({ health }: HeaderProps) {
  const isMock = health?.providerMode === "mock";
  const isLive = health?.providerMode === "live";

  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-20">
      <div className="flex items-center gap-3">
        {/* Logo mark */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center">
            <span className="text-white font-bold text-xs tracking-tight">B</span>
          </div>
          <span className="font-semibold text-white tracking-tight text-lg">BILLZ</span>
        </div>
        {/* Mode badge */}
        {isMock && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            MOCK
          </span>
        )}
        {isLive && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE · {health?.network ?? "base-sepolia"}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 text-xs text-zinc-500 font-mono">
        {health && (
          <span>budget ${health.sessionBudgetUsd.toFixed(2)} / session</span>
        )}
        <span className="text-zinc-700">AI inference router</span>
      </div>
    </header>
  );
}
