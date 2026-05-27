import { describe, it, expect, beforeEach } from "vitest";
import { executeChat } from "./execute";
import { getConfig } from "@/lib/config";
import { subscribeSpend } from "@/lib/events";
import { getBudgetStatus, recordSpend, resetSession } from "@/payment/budget";
import { resetCache } from "@/pipeline/cache";
import type { SpendEvent, StreamEvent } from "@/lib/types";

/** Collect all events from executeChat into an array. */
async function collect(
  ...args: Parameters<typeof executeChat>
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of executeChat(...args)) {
    events.push(ev);
  }
  return events;
}

describe("executeChat — mock mode (default config)", () => {
  const sid1 = "exec-test-1";
  const sid2 = "exec-test-2";
  const sid3 = "exec-test-budget";

  beforeEach(() => {
    resetCache(); // isolate the semantic cache between cases (repeat prompts would hit)
    resetSession(sid1);
    resetSession(sid2);
    resetSession(sid3);
  });

  it("yields at least one delta event", async () => {
    const events = await collect(
      getConfig(),
      { messages: [{ role: "user", content: "hi" }] },
      { sessionId: sid1, traceId: "t1" },
    );
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
  });

  it("yields a done event with provider 'mock' and positive usdcCharged", async () => {
    const events = await collect(
      getConfig(),
      { messages: [{ role: "user", content: "hi" }] },
      { sessionId: sid1, traceId: "t1" },
    );
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);

    const done = doneEvents[0];
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.result.provider).toBe("mock");
      expect(done.result.usdcCharged).toBeGreaterThan(0);
    }
  });

  it("publishes a SpendEvent to the event bus", async () => {
    const received: SpendEvent[] = [];
    const unsub = subscribeSpend((e) => received.push(e));

    await collect(
      getConfig(),
      { messages: [{ role: "user", content: "hello world" }] },
      { sessionId: sid2, traceId: "t2" },
    );

    unsub();
    expect(received.length).toBeGreaterThanOrEqual(1);
    const ev = received[received.length - 1];
    expect(ev.sessionId).toBe(sid2);
    expect(ev.provider).toBe("mock");
    expect(ev.usdcCharged).toBeGreaterThan(0);
    expect(ev.cacheHit).toBe(false);
  });

  it("increases the session's spent amount after a successful call", async () => {
    const before = getBudgetStatus(sid1).spent;

    await collect(
      getConfig(),
      { messages: [{ role: "user", content: "test" }] },
      { sessionId: sid1, traceId: "t3" },
    );

    const after = getBudgetStatus(sid1).spent;
    expect(after).toBeGreaterThan(before);
  });

  it("SpendEvent carries traceId and sessionId", async () => {
    const received: SpendEvent[] = [];
    const unsub = subscribeSpend((e) => received.push(e));

    await collect(
      getConfig(),
      { messages: [{ role: "user", content: "trace check" }] },
      { sessionId: sid2, traceId: "my-trace-id" },
    );

    unsub();
    const ev = received.find((e) => e.sessionId === sid2);
    expect(ev).toBeDefined();
    expect(ev!.traceId).toBe("my-trace-id");
  });
});

describe("executeChat — budget exhaustion", () => {
  const exhaustedSid = "exec-budget-exhausted";

  beforeEach(() => {
    resetCache();
    resetSession(exhaustedSid);
  });

  it("yields a budget error and does not stream when session is exhausted", async () => {
    // Exhaust the budget first.
    recordSpend(exhaustedSid, 5);
    expect(getBudgetStatus(exhaustedSid).exceeded).toBe(true);

    const events = await collect(
      getConfig(),
      { messages: [{ role: "user", content: "this should fail" }] },
      { sessionId: exhaustedSid, traceId: "budget-trace" },
    );

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error).toMatch(/budget/i);
    }
  });

  it("does NOT increase spent when budget is exceeded", async () => {
    recordSpend(exhaustedSid, 5);
    const before = getBudgetStatus(exhaustedSid).spent;

    await collect(
      getConfig(),
      { messages: [{ role: "user", content: "should be blocked" }] },
      { sessionId: exhaustedSid, traceId: "budget-trace-2" },
    );

    const after = getBudgetStatus(exhaustedSid).spent;
    expect(after).toBe(before); // no additional charge
  });

  it("does NOT publish a SpendEvent when budget is exceeded", async () => {
    recordSpend(exhaustedSid, 5);

    const received: SpendEvent[] = [];
    const unsub = subscribeSpend((e) => received.push(e));

    await collect(
      getConfig(),
      { messages: [{ role: "user", content: "blocked" }] },
      { sessionId: exhaustedSid, traceId: "budget-trace-3" },
    );

    unsub();
    const relevantEvents = received.filter((e) => e.sessionId === exhaustedSid);
    expect(relevantEvents.length).toBe(0);
  });
});
