"use client";

import { useMemo } from "react";
import type { ModelOption } from "./useModels";
import type { NewPaneSpec } from "./useWorkspace";
import type { ProviderId } from "@/lib/types";
import { providerAccent } from "./providerTheme";

interface ActivityRailProps {
  models: ModelOption[];
  onOpen: (spec: NewPaneSpec) => void;
  providerMode?: string;
}

function priceHint(m: ModelOption): string | null {
  if (m.outputPricePerM != null) return `$${m.outputPricePerM.toFixed(2)}/M out`;
  return "x402 per-call";
}

export function ActivityRail({ models, onOpen, providerMode }: ActivityRailProps) {
  // Group models by provider, preserving the order providers first appear in.
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries());
  }, [models]);

  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-line bg-surface/40">
      {/* Section header */}
      <div className="flex items-center justify-between px-3.5 h-9 border-b border-line">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
          Models
        </span>
        <span className="text-[10px] text-muted-2 font-mono">{providerMode ?? ""}</span>
      </div>

      <div className="flex-1 overflow-y-auto py-2 scrollbar-thin">
        {/* Router (auto) entry */}
        <RailLeaf
          accentKey="auto"
          label="auto"
          sub="router picks the cheapest"
          onClick={() => onOpen({ model: "auto", label: "auto", provider: "auto" })}
        />

        {groups.length === 0 && (
          <p className="px-3.5 py-3 text-[11px] text-muted-2">Loading models…</p>
        )}

        {groups.map(([provider, list]) => {
          const accent = providerAccent(provider);
          return (
            <div key={provider} className="mt-2">
              <div className="flex items-center gap-1.5 px-3 py-1">
                <span className={`w-1.5 h-1.5 rounded-full ${accent.dot}`} />
                <span className={`text-[11px] uppercase tracking-wider ${accent.text}`}>
                  {provider}
                </span>
              </div>
              {list.map((m) => (
                <RailLeaf
                  key={m.id}
                  accentKey={provider}
                  label={m.label ?? m.id}
                  sub={priceHint(m) ?? undefined}
                  onClick={() =>
                    onOpen({
                      model: m.id,
                      label: m.label ?? m.id,
                      provider: provider as ProviderId,
                    })
                  }
                />
              ))}
            </div>
          );
        })}
      </div>

      <div className="px-3.5 py-2.5 border-t border-line">
        <p className="text-[10px] text-muted-2 leading-snug">
          Click a model to open a terminal. Open as many as you like — each pays its own way.
        </p>
      </div>
    </aside>
  );
}

function RailLeaf({
  accentKey,
  label,
  sub,
  onClick,
}: {
  accentKey: string;
  label: string;
  sub?: string;
  onClick: () => void;
}) {
  const accent = providerAccent(accentKey);
  return (
    <button
      onClick={onClick}
      title={`Open terminal · ${label}`}
      className="group w-full flex items-center justify-between gap-2 pl-6 pr-3.5 py-1.5 text-left hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)] transition-colors"
    >
      <span className="min-w-0">
        <span className="block text-[12px] text-muted font-mono truncate group-hover:text-ink transition-colors">
          {label}
        </span>
        {sub && <span className="block text-[10px] text-muted-2 truncate">{sub}</span>}
      </span>
      <span
        className={`shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-sm leading-none ${accent.text}`}
      >
        +
      </span>
    </button>
  );
}
