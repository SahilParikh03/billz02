/**
 * Two-layer semantic cache for BILLZ.
 *
 * Layer 1 — Exact (L1): FNV-1a hex hash of the canonical conversation string.
 *   Hit returns { kind: "exact", similarity: 1 }.
 *
 * Layer 2 — Semantic (L2): cosine similarity of embedding vs all stored
 *   entries. If best ≥ cfg.cache.simThreshold → semantic hit.
 *
 * Eviction policy: TTL (entries older than cfg.cache.ttlMs are skipped and
 *   removed on lookup) + LRU (when entry count exceeds cfg.cache.maxEntries
 *   the least-recently-accessed entry is dropped on store).
 *
 * Storage: an in-memory Map on globalThis.__billzCache for fast local L1/L2,
 *   plus — when a shared Store (Redis) is configured — a write-through mirror of
 *   the *exact* layer so identical prompts hit the cache across serverless
 *   instances (the highest-value, lowest-risk slice to share; the semantic
 *   nearest-neighbour layer stays per-instance). Falls back to pure in-memory
 *   when the store is process-local.
 */

import type {
  AppConfig,
  CacheLookup,
  CacheStats,
  ChatMessage,
  CompletionResult,
  SemanticCache,
} from "@/lib/types";
import { getStore, isSharedStore, type Store } from "@/lib/store";
import { getEmbedder, cosine } from "./embed";

// ── Canonical conversation string ────────────────────────────────────────────

/**
 * Convert a message array into a single deterministic string suitable for
 * hashing and embedding.
 *
 * Format: each message becomes "<role>: <content>" joined by newlines.
 * The last user turn is appended a second time to up-weight it (it is the
 * most query-like signal and dominates retrieval intent).
 */
function canonicalize(messages: ChatMessage[]): string {
  const lines = messages.map((m) => `${m.role}: ${m.content}`);
  const base = lines.join("\n");

  // Find the last user message and repeat it for emphasis
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return `${base}\n${messages[i].content}`;
    }
  }
  return base;
}

// ── FNV-1a for exact key ─────────────────────────────────────────────────────

function fnv1a32hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── Cache entry ───────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  vector: number[];
  result: CompletionResult;
  createdAt: number;
  lastAccess: number;
}

// ── SemanticCache implementation ──────────────────────────────────────────────

class TwoLayerCache implements SemanticCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly embedder: ReturnType<typeof getEmbedder>;
  private _hits = 0;
  private _misses = 0;
  /** Shared backend for the cross-instance exact layer; null = pure in-memory. */
  private readonly sharedStore: Store | null;

  constructor(private readonly cfg: AppConfig["cache"], store?: Store) {
    this.sharedStore = store ?? null;
    this.embedder = getEmbedder(cfg); // local (default) or minilm per config
  }

  private storeKey(key: string): string {
    return `billz:cache:${key}`;
  }

  // Evict entries whose TTL has expired. Returns true if any were removed.
  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.cfg.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  // Evict the LRU entry (the one with the smallest lastAccess).
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }

  async lookup(messages: ChatMessage[]): Promise<CacheLookup> {
    const now = Date.now();
    this.evictExpired(now);

    const canonical = canonicalize(messages);
    const key = fnv1a32hex(canonical);

    // ── L1: exact key match (in-memory) ──────────────────────────────────────
    const exact = this.entries.get(key);
    if (exact) {
      exact.lastAccess = now;
      this._hits++;
      return { hit: true, kind: "exact", similarity: 1, result: exact.result };
    }

    // ── L1b: exact key match (shared store, cross-instance) ───────────────────
    // Only consulted when a shared backend is configured. On a hit we hydrate
    // the local map (computing the embedding) so subsequent local lookups and
    // the semantic layer benefit too.
    if (this.sharedStore) {
      let raw: string | null = null;
      try {
        raw = await this.sharedStore.get(this.storeKey(key));
      } catch {
        raw = null; // store hiccup → degrade to local-only, never throw
      }
      if (raw) {
        try {
          const result = JSON.parse(raw) as CompletionResult;
          const vector = await this.embedder.embed(canonical);
          this.entries.set(key, { key, vector, result, createdAt: now, lastAccess: now });
          this._hits++;
          return { hit: true, kind: "exact", similarity: 1, result };
        } catch {
          // Corrupt entry — ignore and fall through to the semantic layer.
        }
      }
    }

    // ── L2: semantic nearest-neighbor ────────────────────────────────────────
    const queryVec = await this.embedder.embed(canonical);
    let bestSim = -Infinity;
    let bestEntry: CacheEntry | null = null;

    for (const entry of this.entries.values()) {
      const sim = cosine(queryVec, entry.vector);
      if (sim > bestSim) {
        bestSim = sim;
        bestEntry = entry;
      }
    }

    if (bestEntry !== null && bestSim >= this.cfg.simThreshold) {
      bestEntry.lastAccess = now;
      this._hits++;
      return {
        hit: true,
        kind: "semantic",
        similarity: bestSim,
        result: bestEntry.result,
      };
    }

    this._misses++;
    return { hit: false };
  }

  async store(messages: ChatMessage[], result: CompletionResult): Promise<void> {
    const now = Date.now();
    const canonical = canonicalize(messages);
    const key = fnv1a32hex(canonical);
    const vector = await this.embedder.embed(canonical);

    this.entries.set(key, { key, vector, result, createdAt: now, lastAccess: now });

    // Write-through the exact layer to the shared store (best-effort).
    if (this.sharedStore) {
      try {
        await this.sharedStore.set(this.storeKey(key), JSON.stringify(result), this.cfg.ttlMs);
      } catch {
        // Store unavailable — the local cache still works; don't fail the call.
      }
    }

    // Enforce maxEntries via LRU eviction (evict until within limit)
    while (this.entries.size > this.cfg.maxEntries) {
      this.evictLRU();
    }
  }

  stats(): CacheStats {
    return {
      entries: this.entries.size,
      hits: this._hits,
      misses: this._misses,
    };
  }
}

// ── Singleton management ──────────────────────────────────────────────────────

const g = globalThis as unknown as { __billzCache?: SemanticCache };

/**
 * Return (or create) the process-level singleton cache.
 * The cache is built once from `cfg.cache` settings and stored on globalThis
 * so it survives across hot-reloads in dev. Call `resetCache()` in tests to
 * start fresh between cases.
 */
export function getCache(cfg: AppConfig): SemanticCache {
  if (!g.__billzCache) {
    // Share the exact layer only when the store is a real network backend;
    // a process-local memory store would just duplicate the in-memory Map.
    const store = getStore();
    g.__billzCache = new TwoLayerCache(
      cfg.cache,
      isSharedStore(store) ? store : undefined,
    );
  }
  return g.__billzCache;
}

/**
 * Destroy the singleton — intended for tests and cold-start scenarios only.
 */
export function resetCache(): void {
  g.__billzCache = undefined;
}

/**
 * Build a standalone cache with an explicit store — for tests that exercise the
 * shared-store path without touching the process singleton or env.
 */
export function createCache(
  cacheCfg: AppConfig["cache"],
  store?: Store,
): SemanticCache {
  return new TwoLayerCache(cacheCfg, store);
}
