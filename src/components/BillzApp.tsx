"use client";

import { useCallback, useMemo, useState } from "react";
import { useSession } from "./useSession";
import { useHealth } from "./useHealth";
import { useModels } from "./useModels";
import { useSpendFeed } from "./useSpendFeed";
import { useAccount } from "./cdp/account";
import { useWorkspace } from "./useWorkspace";
import { AuthMenu } from "./cdp/AuthMenu";
import { ActivityRail } from "./ActivityRail";
import { TerminalPane } from "./TerminalPane";
import { StatusBar } from "./StatusBar";
import { SpendFeed } from "./SpendFeed";
import { providerAccent } from "./providerTheme";

export function BillzApp() {
  const sessionId = useSession();
  const account = useAccount();
  const health = useHealth();
  const models = useModels();
  const { events, sessionSpent, sessionBudget, connected } = useSpendFeed();
  const { panes, hydrated, openPane, closePane, focusPane, movePane, resizePane } = useWorkspace();

  const [feedOpen, setFeedOpen] = useState(false);

  const onSettled = useCallback(() => {
    if (account.enabled && account.address) account.refreshCredit();
  }, [account]);

  // The pane with the highest z-index is the focused one.
  const focusedId = useMemo(() => {
    let top: { id: string; z: number } | null = null;
    for (const p of panes) if (!top || p.z > top.z) top = { id: p.id, z: p.z };
    return top?.id ?? null;
  }, [panes]);

  const isMock = health?.providerMode === "mock";
  const isLive = health?.providerMode === "live";

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center h-10 px-3 shrink-0 border-b border-zinc-800 bg-zinc-900/60">
        {/* mac chrome dots */}
        <div className="flex items-center gap-1.5 mr-3">
          <span className="w-3 h-3 rounded-full bg-red-500/80" />
          <span className="w-3 h-3 rounded-full bg-amber-500/80" />
          <span className="w-3 h-3 rounded-full bg-emerald-500/80" />
        </div>
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center">
            <span className="text-white font-bold text-[10px]">B</span>
          </div>
          <span className="text-sm font-semibold tracking-tight text-zinc-200">
            BILLZ <span className="text-zinc-600 font-normal">— workspace</span>
          </span>
        </div>

        {isMock && (
          <span className="ml-3 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            MOCK
          </span>
        )}
        {isLive && (
          <span className="ml-3 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE · {health?.network ?? "base-sepolia"}
          </span>
        )}

        <div className="flex-1" />
        <AuthMenu />
      </div>

      {/* Tab strip — one tab per open terminal */}
      <div className="flex items-stretch h-9 shrink-0 border-b border-zinc-800 bg-zinc-950 overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-800">
        {panes.length === 0 ? (
          <span className="flex items-center px-3 text-[11px] text-zinc-600 font-mono">
            no terminals open
          </span>
        ) : (
          panes.map((p) => {
            const accent = providerAccent(p.provider);
            const active = p.id === focusedId;
            return (
              <button
                key={p.id}
                onClick={() => focusPane(p.id)}
                className={`group flex items-center gap-2 px-3 border-r border-zinc-800 text-xs font-mono whitespace-nowrap transition-colors ${
                  active ? "bg-zinc-900 text-zinc-200" : "text-zinc-500 hover:bg-zinc-900/50"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${accent.dot}`} />
                {p.label}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closePane(p.id);
                  }}
                  className="text-zinc-700 group-hover:text-zinc-400 hover:!text-red-400 transition-colors"
                  aria-label="Close terminal"
                >
                  ✕
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Body: rail + canvas + feed drawer */}
      <div className="flex flex-1 overflow-hidden">
        <ActivityRail models={models} onOpen={openPane} providerMode={health?.providerMode} />

        {/* Canvas */}
        <main className="relative flex-1 overflow-hidden billz-grid-bg">
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              pane={pane}
              sessionId={sessionId}
              userId={account.address}
              events={events}
              focused={pane.id === focusedId}
              onFocus={focusPane}
              onClose={closePane}
              onMove={movePane}
              onResize={resizePane}
              onSettled={onSettled}
            />
          ))}

          {hydrated && panes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center gap-5 px-6">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/20 to-blue-600/20 border border-violet-500/20 flex items-center justify-center text-2xl">
                ⚡
              </div>
              <div>
                <p className="text-zinc-300 font-medium mb-1">Open a terminal to start</p>
                <p className="text-zinc-500 text-sm max-w-sm">
                  Pick a model from the left to spawn a terminal pinned to it. Open several and run
                  different LLMs side by side — each pays its own way over x402.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  onClick={() => openPane({ model: "auto", label: "auto", provider: "auto" })}
                  className="px-3 py-1.5 rounded-lg text-xs font-mono border border-fuchsia-500/40 text-fuchsia-300 hover:bg-fuchsia-500/10 transition-colors"
                >
                  + auto (router)
                </button>
                {models.slice(0, 3).map((m) => {
                  const accent = providerAccent(m.provider);
                  return (
                    <button
                      key={m.id}
                      onClick={() =>
                        openPane({ model: m.id, label: m.label ?? m.id, provider: m.provider as never })
                      }
                      className={`px-3 py-1.5 rounded-lg text-xs font-mono border ${accent.border} ${accent.text} hover:opacity-80 transition-opacity`}
                    >
                      + {m.label ?? m.id}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </main>

        {/* Spend feed drawer */}
        <div
          className={`shrink-0 border-l border-zinc-800 bg-zinc-950 overflow-hidden transition-all duration-300 ${
            feedOpen ? "w-80 xl:w-96" : "w-0"
          }`}
        >
          <div className="w-80 xl:w-96 h-full">
            <SpendFeed
              events={events}
              sessionSpent={sessionSpent}
              sessionBudget={sessionBudget}
              connected={connected}
              network={health?.network}
            />
          </div>
        </div>
      </div>

      <StatusBar
        connected={connected}
        sessionSpent={sessionSpent}
        sessionBudget={sessionBudget}
        network={health?.network}
        eventCount={events.length}
        paneCount={panes.length}
        latest={events[0]}
        feedOpen={feedOpen}
        onToggleFeed={() => setFeedOpen((v) => !v)}
      />
    </div>
  );
}
