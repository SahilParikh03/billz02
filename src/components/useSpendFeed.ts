"use client";

import { useEffect, useRef, useState } from "react";

export interface SpendEvent {
  ts: number;
  traceId: string;
  sessionId: string;
  provider: string;
  model: string;
  reason: string;
  usdcCharged: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  paymentMode: "x402-percall" | "credit-balance" | "mock";
  settlementTxHash?: string;
  cacheHit: boolean;
  sessionSpent: number;
  sessionBudget: number;
}

interface SpendFeedState {
  events: SpendEvent[];
  sessionSpent: number;
  sessionBudget: number;
  connected: boolean;
}

const MAX_EVENTS = 50;

export function useSpendFeed(): SpendFeedState {
  const [events, setEvents] = useState<SpendEvent[]>([]);
  const [sessionSpent, setSessionSpent] = useState(0);
  const [sessionBudget, setSessionBudget] = useState(5);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/feed");
    esRef.current = es;

    es.addEventListener("open", () => setConnected(true));

    es.addEventListener("message", (e: MessageEvent) => {
      try {
        const event: SpendEvent = JSON.parse(e.data);
        setEvents((prev) => {
          const next = [event, ...prev];
          return next.slice(0, MAX_EVENTS);
        });
        setSessionSpent(event.sessionSpent);
        setSessionBudget(event.sessionBudget);
      } catch {
        // malformed event — ignore
      }
    });

    es.addEventListener("error", () => {
      setConnected(false);
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return { events, sessionSpent, sessionBudget, connected };
}
