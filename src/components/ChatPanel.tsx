"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  KeyboardEvent,
} from "react";
import { ChatMessage } from "./useChat";
import { ModelOption } from "./useModels";
import type { LeaderboardRow } from "@/lib/types";

interface ChatPanelProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  onSend: (content: string) => void;
  onFeedback: (traceId: string, rating: "up" | "down") => Promise<void>;
  models: ModelOption[];
  selectedModel: string;
  onModelChange: (model: string) => void;
}

function ProviderDot({ model }: { model: string }) {
  const bg = model.includes("venice")
    ? "bg-violet-500"
    : model.includes("hyperbolic")
    ? "bg-blue-500"
    : model === "auto"
    ? "bg-gradient-to-br from-violet-500 to-blue-500"
    : "bg-zinc-500";
  return <span className={`inline-block w-2 h-2 rounded-full ${bg} mr-1.5 shrink-0`} />;
}

// ── Feedback thumbs ────────────────────────────────────────────────────────────

type FeedbackState = "up" | "down" | null;

function ThumbButtons({
  traceId,
  onFeedback,
}: {
  traceId: string;
  onFeedback: (traceId: string, rating: "up" | "down") => Promise<void>;
}) {
  const [voted, setVoted] = useState<FeedbackState>(null);
  const [busy, setBusy] = useState(false);

  const vote = useCallback(
    async (rating: "up" | "down") => {
      if (voted !== null || busy) return;
      setBusy(true);
      try {
        await onFeedback(traceId, rating);
        setVoted(rating);
      } finally {
        setBusy(false);
      }
    },
    [traceId, onFeedback, voted, busy],
  );

  const baseBtn =
    "w-6 h-6 rounded flex items-center justify-center text-sm transition-colors disabled:cursor-not-allowed";

  return (
    <div className="flex gap-1 mt-1.5" aria-label="Rate this response">
      <button
        onClick={() => vote("up")}
        disabled={voted !== null || busy}
        title="Helpful"
        className={`${baseBtn} ${
          voted === "up"
            ? "bg-emerald-600/30 text-emerald-400"
            : voted === "down"
            ? "text-zinc-600"
            : "text-zinc-500 hover:text-emerald-400 hover:bg-emerald-600/20"
        }`}
      >
        👍
      </button>
      <button
        onClick={() => vote("down")}
        disabled={voted !== null || busy}
        title="Not helpful"
        className={`${baseBtn} ${
          voted === "down"
            ? "bg-red-600/30 text-red-400"
            : voted === "up"
            ? "text-zinc-600"
            : "text-zinc-500 hover:text-red-400 hover:bg-red-600/20"
        }`}
      >
        👎
      </button>
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  onFeedback,
}: {
  msg: ChatMessage;
  onFeedback: (traceId: string, rating: "up" | "down") => Promise<void>;
}) {
  const isUser = msg.role === "user";
  const isError = msg.budgetExceeded;
  const showThumbs = !isUser && msg.done && !isError && msg.traceId;

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[78%] rounded-2xl rounded-tr-sm px-4 py-2.5 bg-violet-600 text-white text-sm leading-relaxed whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className="flex gap-3 max-w-[85%]">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-white text-xs font-bold">B</span>
        </div>
        <div>
          <div
            className={`rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
              isError
                ? "bg-red-950/50 border border-red-800/50 text-red-300"
                : "bg-zinc-800 text-zinc-100"
            }`}
          >
            {msg.content || (
              <span className="flex gap-1 items-center text-zinc-500 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" />
              </span>
            )}
            {!msg.done && msg.content && (
              <span className="inline-block w-0.5 h-4 bg-violet-400 ml-0.5 animate-pulse align-middle" />
            )}
            {isError && (
              <div className="mt-1.5 text-xs text-red-400 font-medium">Budget exceeded</div>
            )}
          </div>
          {showThumbs && (
            <ThumbButtons traceId={msg.traceId!} onFeedback={onFeedback} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Leaderboard panel ──────────────────────────────────────────────────────────

function LeaderboardPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((data: LeaderboardRow[]) => {
        setRows(data);
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load leaderboard");
        setLoading(false);
      });
  }, []);

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-10 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-xs font-semibold text-zinc-300 tracking-wide uppercase">
          Quality Leaderboard
        </span>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
          aria-label="Close leaderboard"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M11 3L3 11M3 3l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="max-h-48 overflow-y-auto">
        {loading && (
          <p className="text-xs text-zinc-500 px-3 py-4 text-center">Loading…</p>
        )}
        {error && (
          <p className="text-xs text-red-400 px-3 py-4 text-center">{error}</p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="text-xs text-zinc-500 px-3 py-4 text-center">
            No votes yet — chat and rate responses first.
          </p>
        )}
        {!loading && !error && rows.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left px-3 py-1.5 font-medium">Model</th>
                <th className="text-left px-2 py-1.5 font-medium">Task</th>
                <th className="text-right px-2 py-1.5 font-medium">Win%</th>
                <th className="text-right px-3 py-1.5 font-medium">Q/$</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((row, i) => (
                <tr
                  key={`${row.taskClass}-${row.provider}-${row.model}`}
                  className={`${i % 2 === 0 ? "bg-zinc-900" : "bg-zinc-900/50"} hover:bg-zinc-800/50 transition-colors`}
                >
                  <td className="px-3 py-1.5 text-zinc-300 font-mono truncate max-w-[120px]">
                    {row.model}
                  </td>
                  <td className="px-2 py-1.5 text-zinc-400">{row.taskClass}</td>
                  <td className="text-right px-2 py-1.5 text-zinc-300">
                    {(row.winRate * 100).toFixed(0)}%
                  </td>
                  <td className="text-right px-3 py-1.5 text-violet-300 font-mono">
                    {row.qualityPerDollar > 0 ? row.qualityPerDollar.toFixed(1) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function ChatPanel({
  messages,
  isStreaming,
  onSend,
  onFeedback,
  models,
  selectedModel,
  onModelChange,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    onSend(input.trim());
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-16">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/20 to-blue-600/20 border border-violet-500/20 flex items-center justify-center">
              <span className="text-2xl">⚡</span>
            </div>
            <div>
              <p className="text-zinc-300 font-medium mb-1">Ask BEAMR anything</p>
              <p className="text-zinc-500 text-sm max-w-xs">
                Your request is routed to the best model. Every charge shows up live in the feed.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {[
                "Explain x402 payments",
                "Write a haiku about crypto",
                "What is Base?",
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                  className="px-3 py-1.5 rounded-full text-xs border border-zinc-700 text-zinc-400 hover:border-violet-500/50 hover:text-violet-300 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} onFeedback={onFeedback} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="relative border-t border-zinc-800 bg-zinc-950/50 px-4 py-3">
        {/* Leaderboard flyout */}
        {showLeaderboard && (
          <LeaderboardPanel onClose={() => setShowLeaderboard(false)} />
        )}

        {/* Model picker + leaderboard toggle */}
        {models.length > 0 && (
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <ProviderDot model={selectedModel} />
              <select
                value={selectedModel}
                onChange={(e) => onModelChange(e.target.value)}
                className="text-xs text-zinc-400 bg-transparent border-0 outline-none cursor-pointer hover:text-zinc-200 transition-colors font-mono"
              >
                <option value="auto">auto (router picks)</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label ?? m.id} · {m.provider}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => setShowLeaderboard((v) => !v)}
              title="Quality leaderboard"
              className={`text-xs px-2 py-1 rounded-md transition-colors ${
                showLeaderboard
                  ? "bg-violet-600/30 text-violet-300 border border-violet-600/40"
                  : "text-zinc-500 hover:text-zinc-300 border border-transparent hover:border-zinc-700"
              }`}
            >
              Leaderboard
            </button>
          </div>
        )}

        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            disabled={isStreaming}
            placeholder={isStreaming ? "Streaming response…" : "Message BEAMR… (Enter to send, Shift+Enter for newline)"}
            rows={1}
            className="flex-1 resize-none rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 text-sm px-3 py-2.5 outline-none focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed"
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="w-10 h-10 rounded-xl flex items-center justify-center bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition-colors shrink-0"
            aria-label="Send message"
          >
            {isStreaming ? (
              <span className="w-4 h-4 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                className="translate-x-0.5 -translate-y-0.5"
              >
                <path
                  d="M14 2L7 9M14 2L10 14L7 9M14 2L2 6L7 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
        <p className="text-xs text-zinc-600 mt-1.5">
          Powered by BEAMR · gasless USDC on Base · every call settled on-chain
        </p>
      </div>
    </div>
  );
}
