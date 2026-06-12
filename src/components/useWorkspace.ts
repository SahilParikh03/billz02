"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderId } from "@/lib/types";

/**
 * One open terminal pane. A pane is pinned to exactly one model/provider — the
 * core BEAMR interaction is the user choosing which LLM each terminal talks to
 * (manual panes, not invisible routing). Geometry is free-floating: panes are
 * absolutely positioned on the canvas and the user drags/resizes them.
 */
export interface Pane {
  id: string;
  /** model id sent verbatim to the API (or "auto" for the router pane) */
  model: string;
  /** display label for the header */
  label: string;
  provider: ProviderId | "auto";
  x: number;
  y: number;
  w: number;
  h: number;
  /** stacking order; higher = on top */
  z: number;
}

export interface NewPaneSpec {
  model: string;
  label: string;
  provider: ProviderId | "auto";
}

const STORAGE_KEY = "beamr_workspace_v1";
const MIN_W = 280;
const MIN_H = 200;

interface PersistShape {
  panes: Pane[];
  zCounter: number;
}

function load(): PersistShape | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistShape;
    if (!Array.isArray(parsed.panes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface Workspace {
  panes: Pane[];
  hydrated: boolean;
  openPane: (spec: NewPaneSpec) => void;
  closePane: (id: string) => void;
  focusPane: (id: string) => void;
  movePane: (id: string, x: number, y: number) => void;
  resizePane: (id: string, w: number, h: number) => void;
}

/**
 * Workspace pane state, persisted to localStorage. Cascades newly opened panes
 * so they don't stack exactly on top of each other.
 */
export function useWorkspace(): Workspace {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const zCounter = useRef(1);
  const openCount = useRef(0);

  // Hydrate from localStorage once on mount (avoids SSR/client mismatch).
  useEffect(() => {
    const saved = load();
    if (saved) {
      setPanes(saved.panes);
      zCounter.current = saved.zCounter ?? saved.panes.length + 1;
      openCount.current = saved.panes.length;
    }
    setHydrated(true);
  }, []);

  // Persist on every change (after hydration).
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const shape: PersistShape = { panes, zCounter: zCounter.current };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [panes, hydrated]);

  const openPane = useCallback((spec: NewPaneSpec) => {
    const z = ++zCounter.current;
    const n = openCount.current++;
    // Cascade from top-left, wrapping so we don't march off-screen.
    const step = 28;
    const x = 40 + (n % 6) * step;
    const y = 36 + (n % 6) * step;
    const pane: Pane = {
      id: crypto.randomUUID(),
      model: spec.model,
      label: spec.label,
      provider: spec.provider,
      x,
      y,
      w: 460,
      h: 380,
      z,
    };
    setPanes((prev) => [...prev, pane]);
  }, []);

  const closePane = useCallback((id: string) => {
    setPanes((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const focusPane = useCallback((id: string) => {
    const z = ++zCounter.current;
    setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, z } : p)));
  }, []);

  const movePane = useCallback((id: string, x: number, y: number) => {
    setPanes((prev) =>
      prev.map((p) => (p.id === id ? { ...p, x: Math.max(0, x), y: Math.max(0, y) } : p)),
    );
  }, []);

  const resizePane = useCallback((id: string, w: number, h: number) => {
    setPanes((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) } : p,
      ),
    );
  }, []);

  return { panes, hydrated, openPane, closePane, focusPane, movePane, resizePane };
}
