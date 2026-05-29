"use client";

import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChat } from "./useChat";
import type { SpendEvent } from "./useSpendFeed";
import { providerAccent } from "./providerTheme";
import type { Pane } from "./useWorkspace";

interface TerminalPaneProps {
  pane: Pane;
  sessionId: string;
  userId?: string | null;
  /** all live spend events — used to compute this pane's running total by traceId */
  events: SpendEvent[];
  focused: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  /** refresh signed-in user's credit after a settled call */
  onSettled?: () => void;
}

function formatUsdc(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  return `$${amount.toFixed(4)}`;
}

// ── Per-message feedback thumbs (terminal-styled) ────────────────────────────

function Thumbs({
  traceId,
  onFeedback,
}: {
  traceId: string;
  onFeedback: (traceId: string, rating: "up" | "down") => Promise<void>;
}) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
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

  return (
    <div className="flex gap-2 mt-1 pl-4 text-[11px]">
      <button
        onClick={() => vote("up")}
        disabled={voted !== null || busy}
        className={`transition-colors ${
          voted === "up"
            ? "text-emerald-400"
            : voted === "down"
            ? "text-zinc-700"
            : "text-zinc-600 hover:text-emerald-400"
        }`}
        title="Helpful"
      >
        [+]
      </button>
      <button
        onClick={() => vote("down")}
        disabled={voted !== null || busy}
        className={`transition-colors ${
          voted === "down"
            ? "text-red-400"
            : voted === "up"
            ? "text-zinc-700"
            : "text-zinc-600 hover:text-red-400"
        }`}
        title="Not helpful"
      >
        [-]
      </button>
    </div>
  );
}

// ── Pane ─────────────────────────────────────────────────────────────────────

export function TerminalPane({
  pane,
  sessionId,
  userId,
  events,
  focused,
  onFocus,
  onClose,
  onMove,
  onResize,
  onSettled,
}: TerminalPaneProps) {
  const accent = providerAccent(pane.provider);
  const { messages, isStreaming, sendMessage, sendFeedback } = useChat({
    sessionId,
    model: pane.model,
    userId,
  });

  const [input, setInput] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new output.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Refresh credit once a streaming response finishes.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) onSettled?.();
    wasStreaming.current = isStreaming;
  }, [isStreaming, onSettled]);

  // This pane's running spend: sum spend events whose traceId matches one of our
  // completed assistant messages. Honest per-pane attribution even when two panes
  // share the same model.
  const paneSpend = useMemo(() => {
    const traceIds = new Set(
      messages.filter((m) => m.traceId).map((m) => m.traceId as string),
    );
    if (traceIds.size === 0) return 0;
    return events
      .filter((e) => traceIds.has(e.traceId))
      .reduce((sum, e) => sum + e.usdcCharged, 0);
  }, [messages, events]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    sendMessage(text);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  }, [input, isStreaming, sendMessage]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  // ── Drag (header) and resize (corner grip) via pointer capture ─────────────
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Ignore drags that start on the close button.
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      onFocus(pane.id);
      drag.current = { px: e.clientX, py: e.clientY, ox: pane.x, oy: pane.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [onFocus, pane.id, pane.x, pane.y],
  );
  const onHeaderPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!drag.current) return;
      onMove(pane.id, drag.current.ox + (e.clientX - drag.current.px), drag.current.oy + (e.clientY - drag.current.py));
    },
    [onMove, pane.id],
  );
  const endHeaderDrag = useCallback((e: ReactPointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  const rez = useRef<{ px: number; py: number; ow: number; oh: number } | null>(null);
  const onGripPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.stopPropagation();
      onFocus(pane.id);
      rez.current = { px: e.clientX, py: e.clientY, ow: pane.w, oh: pane.h };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [onFocus, pane.id, pane.w, pane.h],
  );
  const onGripPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!rez.current) return;
      onResize(pane.id, rez.current.ow + (e.clientX - rez.current.px), rez.current.oh + (e.clientY - rez.current.py));
    },
    [onResize, pane.id],
  );
  const endGrip = useCallback((e: ReactPointerEvent) => {
    rez.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  return (
    <div
      className={`absolute flex flex-col rounded-lg border bg-zinc-950/95 backdrop-blur-sm overflow-hidden font-mono shadow-2xl transition-shadow ${accent.border} ${
        focused ? `ring-1 ${accent.ring}` : ""
      }`}
      style={{
        left: pane.x,
        top: pane.y,
        width: pane.w,
        height: pane.h,
        zIndex: pane.z,
        boxShadow: focused ? `0 0 0 1px ${accent.glow}, 0 18px 50px -12px ${accent.glow}` : undefined,
      }}
      onPointerDown={() => onFocus(pane.id)}
    >
      {/* Title bar — drag handle */}
      <div
        className={`flex items-center justify-between gap-2 px-3 h-8 shrink-0 cursor-move select-none border-b ${accent.border} ${accent.headerBg}`}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${accent.dot}`} />
          <span className={`text-xs truncate ${accent.text}`}>{pane.label}</span>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider shrink-0">
            {pane.provider}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-emerald-400/90 tabular-nums" title="Spent in this terminal">
            {formatUsdc(paneSpend)}
          </span>
          <button
            data-no-drag
            onClick={() => onClose(pane.id)}
            className="text-zinc-600 hover:text-red-400 transition-colors text-xs leading-none"
            aria-label="Close terminal"
            title="Close terminal"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Output */}
      <div
        ref={bodyRef}
        className="flex-1 overflow-y-auto px-3 py-2 text-[12.5px] leading-relaxed scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent"
      >
        {messages.length === 0 ? (
          <p className="text-zinc-600 text-[11px]">
            <span className={accent.text}>{pane.label}</span> ready · type below to start. Each call
            is paid per-request over x402.
          </p>
        ) : (
          messages.map((msg) => {
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="mb-1.5 flex gap-1.5">
                  <span className={`${accent.text} shrink-0`}>❯</span>
                  <span className="text-zinc-300 whitespace-pre-wrap break-words">{msg.content}</span>
                </div>
              );
            }
            const isError = msg.budgetExceeded;
            return (
              <div key={msg.id} className="mb-3">
                <div
                  className={`whitespace-pre-wrap break-words pl-4 ${
                    isError ? "text-red-400" : "text-zinc-200"
                  }`}
                >
                  {msg.content || <span className="text-zinc-600">…</span>}
                  {!msg.done && msg.content && (
                    <span className={`inline-block w-1.5 h-3.5 ml-0.5 align-middle animate-pulse ${accent.dot}`} />
                  )}
                </div>
                {msg.done && !isError && msg.traceId && (
                  <Thumbs traceId={msg.traceId} onFeedback={sendFeedback} />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Prompt input */}
      <div className={`flex items-end gap-2 px-3 py-2 border-t ${accent.border} bg-black/30`}>
        <span className={`${accent.text} text-xs pb-1.5 shrink-0`}>$</span>
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          disabled={isStreaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onInput={() => {
            const el = inputRef.current;
            if (!el) return;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
          }}
          placeholder={isStreaming ? "running…" : "message this model…"}
          className="flex-1 resize-none bg-transparent text-zinc-200 placeholder-zinc-600 text-[12.5px] outline-none disabled:opacity-50 leading-relaxed"
        />
        {isStreaming && (
          <span className="w-3 h-3 mb-1.5 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin shrink-0" />
        )}
      </div>

      {/* Resize grip */}
      <div
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={endGrip}
        onPointerCancel={endGrip}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
        style={{
          background:
            "linear-gradient(135deg, transparent 0 50%, rgba(113,113,122,0.6) 50% 60%, transparent 60% 70%, rgba(113,113,122,0.6) 70% 80%, transparent 80%)",
        }}
        aria-label="Resize terminal"
      />
    </div>
  );
}
