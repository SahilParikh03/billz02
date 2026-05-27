"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "billz_session";
let cached: string | null = null;

/** Read or lazily create the persisted session id (client only). */
function getSnapshot(): string {
  if (cached) return cached;
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  cached = id;
  return id;
}

// The session id is stable for the lifetime of the tab, so it never changes.
function subscribe(): () => void {
  return () => {};
}

/**
 * A stable per-tab session id, persisted to localStorage. Uses
 * useSyncExternalStore so the value is read SSR-safely (the server snapshot is
 * "") without a setState-in-effect or a hydration mismatch.
 */
export function useSession(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => "");
}
