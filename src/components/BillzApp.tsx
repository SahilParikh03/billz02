"use client";

import { useCallback, useState } from "react";
import { useSession } from "./useSession";
import { useChat } from "./useChat";
import { useSpendFeed } from "./useSpendFeed";
import { useHealth } from "./useHealth";
import { useModels } from "./useModels";
import { useAccount } from "./cdp/account";
import { Header } from "./Header";
import { ChatPanel } from "./ChatPanel";
import { SpendFeed } from "./SpendFeed";

export function BillzApp() {
  const sessionId = useSession();
  const account = useAccount();
  const health = useHealth();
  const models = useModels();
  const [selectedModel, setSelectedModel] = useState("auto");

  const { messages, isStreaming, sendMessage, sendFeedback } = useChat({
    sessionId,
    model: selectedModel,
    userId: account.address,
  });

  // After a signed-in user's message settles, refresh their credit balance.
  const handleSend = useCallback(
    async (content: string) => {
      await sendMessage(content);
      if (account.enabled && account.address) await account.refreshCredit();
    },
    [sendMessage, account],
  );

  const { events, sessionSpent, sessionBudget, connected } = useSpendFeed();

  const [feedOpen, setFeedOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <Header health={health} />

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex flex-col flex-1 min-w-0">
          <ChatPanel
            messages={messages}
            isStreaming={isStreaming}
            onSend={handleSend}
            onFeedback={sendFeedback}
            models={models}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
          />
        </div>

        {/* Feed panel — sidebar on desktop, drawer on mobile */}
        {/* Desktop sidebar */}
        <div className="hidden lg:flex flex-col w-80 xl:w-96 border-l border-zinc-800 shrink-0 overflow-hidden">
          <SpendFeed
            events={events}
            sessionSpent={sessionSpent}
            sessionBudget={sessionBudget}
            connected={connected}
          />
        </div>

        {/* Mobile feed drawer */}
        <div
          className={`lg:hidden fixed inset-0 z-30 transition-opacity duration-300 ${
            feedOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setFeedOpen(false)}
          />
          {/* Panel */}
          <div
            className={`absolute right-0 top-0 bottom-0 w-80 bg-zinc-950 border-l border-zinc-800 transition-transform duration-300 ${
              feedOpen ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <button
                onClick={() => setFeedOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
                aria-label="Close feed"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <div className="h-full overflow-hidden">
              <SpendFeed
                events={events}
                sessionSpent={sessionSpent}
                sessionBudget={sessionBudget}
                connected={connected}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile feed toggle button */}
      <div className="lg:hidden fixed bottom-20 right-4 z-20">
        <button
          onClick={() => setFeedOpen(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 shadow-lg hover:bg-zinc-700 transition-colors"
        >
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
          Feed
          {events.length > 0 && (
            <span className="bg-violet-600 text-white text-[10px] rounded-full px-1.5 py-0.5 font-mono">
              {events.length}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
