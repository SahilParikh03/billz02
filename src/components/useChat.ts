"use client";

import { useCallback, useRef, useState } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Set on assistant messages when streaming is complete */
  done?: boolean;
  /** Set when a 402 budget error occurs */
  budgetExceeded?: boolean;
}

interface UseChatOptions {
  sessionId: string;
  model?: string;
}

interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
}

export function useChat({ sessionId, model = "auto" }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || !sessionId || isStreaming) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: content.trim(),
      };

      const assistantMsgId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        done: false,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      // Build the history to send (all user+assistant messages so far, plus the new user one)
      const history = messages
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.done && !m.budgetExceeded))
        .map((m) => ({ role: m.role, content: m.content }));

      const body = {
        model,
        stream: true,
        messages: [...history, { role: "user" as const, content: content.trim() }],
        session_id: sessionId,
      };

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = await fetch("/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Billz-Session": sessionId,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });

        // Handle 402 budget exceeded
        if (res.status === 402) {
          const errData = await res.json().catch(() => ({}));
          const msg = errData?.error?.message ?? "Session budget exceeded.";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: msg, done: true, budgetExceeded: true }
                : m
            )
          );
          setIsStreaming(false);
          return;
        }

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") break;
            try {
              const chunk = JSON.parse(raw);
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId ? { ...m, content: m.content + delta } : m
                  )
                );
              }
            } catch {
              // malformed chunk — skip
            }
          }
        }

        // Mark done
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, done: true } : m))
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        const errMsg =
          err instanceof Error ? err.message : "Something went wrong. Please try again.";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: errMsg, done: true, budgetExceeded: false }
              : m
          )
        );
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, sessionId, model, isStreaming]
  );

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setIsStreaming(false);
  }, []);

  return { messages, isStreaming, sendMessage, clearMessages };
}
