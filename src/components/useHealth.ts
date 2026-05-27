"use client";

import { useEffect, useState } from "react";

export interface HealthData {
  ok: boolean;
  providerMode: "mock" | "live";
  network: string;
  sessionBudgetUsd: number;
  facilitator: string;
}

export function useHealth(): HealthData | null {
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: HealthData) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {/* health is non-critical */});
    return () => {
      cancelled = true;
    };
  }, []);

  return health;
}
