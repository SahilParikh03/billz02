import type { SpendEvent } from "./types";

/**
 * In-memory spend-event bus for the live feed.
 *
 * Stage 0 only: this is process-local, so it works for `next dev` and a single
 * serverless instance but NOT across horizontally-scaled instances. Stage 2
 * replaces this with Redis pub/sub. Kept on `globalThis` so it survives the
 * module re-evaluation that Next.js does during HMR in development.
 */

type Subscriber = (e: SpendEvent) => void;

interface Bus {
  subs: Set<Subscriber>;
  recent: SpendEvent[];
}

const MAX_RECENT = 100;

const g = globalThis as unknown as { __beamrBus?: Bus };

function bus(): Bus {
  if (!g.__beamrBus) g.__beamrBus = { subs: new Set(), recent: [] };
  return g.__beamrBus;
}

export function publishSpend(e: SpendEvent): void {
  const b = bus();
  b.recent.push(e);
  if (b.recent.length > MAX_RECENT) b.recent.shift();
  for (const sub of b.subs) {
    try {
      sub(e);
    } catch {
      // a slow/broken subscriber must never block the others
    }
  }
}

/** Subscribe to spend events. Returns an unsubscribe function. */
export function subscribeSpend(cb: Subscriber): () => void {
  const b = bus();
  b.subs.add(cb);
  return () => {
    b.subs.delete(cb);
  };
}

/** Snapshot of recent events, for replay when a feed client first connects. */
export function recentSpend(): SpendEvent[] {
  return [...bus().recent];
}
