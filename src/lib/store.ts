/**
 * Pluggable async key-value store.
 *
 * Stage 0/1 kept budget/cache/feed state in process-local Maps, which do not span
 * horizontally-scaled serverless instances. Stage 2 introduces this `Store` so the
 * correctness-critical state (the spend budget) can be backed by a shared store in
 * production while still defaulting to in-memory for dev and tests.
 *
 * - `createMemoryStore()` — process-local; the default.
 * - `createRedisStore(url, token)` — Upstash Redis REST (no persistent socket, so
 *   it works in serverless). Activated when REDIS_URL/REDIS_TOKEN (or the
 *   UPSTASH_REDIS_REST_* equivalents) are set.
 *
 * `incrByFloat` must be atomic for budget correctness under concurrency — trivially
 * so in the single-threaded memory store, and via Redis INCRBYFLOAT in the adapter.
 */

export interface Store {
  readonly id: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Atomically add `by` to a numeric key (created at 0), return the new value. */
  incrByFloat(key: string, by: number, ttlMs?: number): Promise<number>;
  del(key: string): Promise<void>;
  /** Liveness probe: true if the backing store is reachable. Never throws. */
  ping(): Promise<boolean>;
}

/** True when this store is shared across instances (i.e. a real network backend). */
export function isSharedStore(store: Store): boolean {
  return store.id !== "memory";
}

// ── In-memory store ─────────────────────────────────────────────────────────

interface MemEntry {
  value: string;
  expireAt: number | null;
}

export function createMemoryStore(): Store {
  const map = new Map<string, MemEntry>();

  const live = (key: string): MemEntry | null => {
    const e = map.get(key);
    if (!e) return null;
    if (e.expireAt != null && Date.now() > e.expireAt) {
      map.delete(key);
      return null;
    }
    return e;
  };

  return {
    id: "memory",
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlMs) {
      map.set(key, { value, expireAt: ttlMs != null ? Date.now() + ttlMs : null });
    },
    async incrByFloat(key, by, ttlMs) {
      const e = live(key);
      const next = (e ? Number(e.value) : 0) + by;
      map.set(key, {
        value: String(next),
        // Set TTL on creation; preserve an existing expiry (fixed window).
        expireAt: e ? e.expireAt : ttlMs != null ? Date.now() + ttlMs : null,
      });
      return next;
    },
    async del(key) {
      map.delete(key);
    },
    async ping() {
      return true; // in-process: always reachable
    },
  };
}

// ── Upstash Redis REST store ──────────────────────────────────────────────────

export function createRedisStore(url: string, token: string): Store {
  const base = url.replace(/\/$/, "");

  async function cmd(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`redis ${args[0]} failed: HTTP ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`redis ${args[0]}: ${json.error}`);
    return json.result ?? null;
  }

  return {
    id: "redis",
    async get(key) {
      const r = await cmd(["GET", key]);
      return r == null ? null : String(r);
    },
    async set(key, value, ttlMs) {
      if (ttlMs != null) await cmd(["SET", key, value, "PX", Math.ceil(ttlMs)]);
      else await cmd(["SET", key, value]);
    },
    async incrByFloat(key, by, ttlMs) {
      const r = await cmd(["INCRBYFLOAT", key, by]);
      if (ttlMs != null) {
        // Fixed window: only set the expiry if the key has none yet.
        await cmd(["PEXPIRE", key, Math.ceil(ttlMs), "NX"]);
      }
      return Number(r);
    },
    async del(key) {
      await cmd(["DEL", key]);
    },
    async ping() {
      try {
        return String(await cmd(["PING"])) === "PONG";
      } catch {
        return false;
      }
    },
  };
}

// ── Singleton (env-driven) ─────────────────────────────────────────────────────

const g = globalThis as unknown as { __billzStore?: Store };

export function getStore(): Store {
  if (g.__billzStore) return g.__billzStore;
  const url = process.env.REDIS_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.REDIS_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  g.__billzStore = url && token ? createRedisStore(url, token) : createMemoryStore();
  return g.__billzStore;
}

/** Reset the singleton — for tests. */
export function resetStore(): void {
  g.__billzStore = undefined;
}
