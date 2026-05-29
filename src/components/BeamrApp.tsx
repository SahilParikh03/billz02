"use client";

import { useCallback, useMemo, useState } from "react";
import { useSession } from "./useSession";
import { useHealth } from "./useHealth";
import { useModels } from "./useModels";
import { useSpendFeed } from "./useSpendFeed";
import { useAccount } from "./cdp/account";
import { useWorkspace } from "./useWorkspace";
import { AuthMenu } from "./cdp/AuthMenu";
import { ThemeToggle } from "./ThemeToggle";
import { ActivityRail } from "./ActivityRail";
import { TerminalPane } from "./TerminalPane";
import { StatusBar } from "./StatusBar";
import { SpendFeed } from "./SpendFeed";
import { providerAccent } from "./providerTheme";

export function BeamrApp() {
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
    <div className="flex flex-col h-screen overflow-hidden text-ink">
      {/* Title bar */}
      <div className="glass-bar relative z-20 flex items-center h-11 px-3.5 shrink-0 border-b border-line">
        {/* mac chrome dots */}
        <div className="flex items-center gap-2 mr-3.5">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex items-center gap-2.5">
          <a
            href="/"
            aria-label="BEAMR home"
            className="shrink-0 transition-opacity hover:opacity-80"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/favicon-32.png"
              alt="BEAMR"
              width={20}
              height={20}
              className="w-5 h-5 rounded-md"
            />
          </a>
          <span className="font-display text-[15px] font-semibold tracking-tight text-ink">
            BEAMR
            <span className="text-muted-2 font-normal"> — workspace</span>
          </span>
        </div>

        {isMock && (
          <span className="ml-3 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Mock
          </span>
        )}
        {isLive && (
          <span className="ml-3 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live · {health?.network ?? "base-sepolia"}
          </span>
        )}

        <div className="flex-1" />
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          <AuthMenu />
        </div>
      </div>

      {/* Tab strip — one tab per open terminal */}
      <div className="glass-bar flex items-stretch h-9 shrink-0 border-b border-line overflow-x-auto scrollbar-thin">
        {panes.length === 0 ? (
          <span className="flex items-center px-3.5 text-[11px] text-muted-2 font-mono">
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
                className={`group relative flex items-center gap-2 pl-3.5 pr-2.5 text-xs font-mono whitespace-nowrap transition-colors ${
                  active
                    ? "text-ink bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]"
                    : "text-muted hover:text-ink hover:bg-[color-mix(in_oklab,var(--ink)_4%,transparent)]"
                }`}
              >
                {active && (
                  <span className="absolute left-0 right-0 -bottom-px h-px bg-accent" />
                )}
                <span className={`w-1.5 h-1.5 rounded-full ${accent.dot}`} />
                {p.label}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closePane(p.id);
                  }}
                  className="ml-0.5 grid place-items-center w-4 h-4 rounded text-muted-2 group-hover:text-muted hover:!text-ink hover:bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] transition-colors"
                  aria-label="Close terminal"
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
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
        <main className="relative flex-1 overflow-hidden beamr-grid-bg">
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
              <div className="glass w-16 h-16 rounded-2xl flex items-center justify-center text-accent">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M4 6.5h16M4 12h16M4 17.5h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <p className="font-display text-lg font-medium text-ink mb-1.5">
                  Open a terminal to start
                </p>
                <p className="text-muted text-sm max-w-sm leading-relaxed">
                  Pick a model from the left to spawn a terminal pinned to it. Open several and run
                  different models side by side — each pays its own way over x402.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  onClick={() => openPane({ model: "auto", label: "auto", provider: "auto" })}
                  className="glass-btn px-3.5 py-1.5 rounded-lg text-xs font-mono text-fuchsia-500 dark:text-fuchsia-300"
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
                      className={`glass-btn px-3.5 py-1.5 rounded-lg text-xs font-mono ${accent.text}`}
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
          className={`shrink-0 border-l border-line bg-surface/60 overflow-hidden transition-all duration-300 ${
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
