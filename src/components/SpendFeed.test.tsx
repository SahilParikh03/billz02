// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SpendFeed } from "./SpendFeed";
import type { SpendEvent } from "./useSpendFeed";

// React 19 + Vitest: flush renders synchronously inside act() so no scheduler
// commit task fires after the jsdom environment is torn down (which would throw
// "window is not defined"). Unmount between tests so cleanup clears timers.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => cleanup());

function makeEvent(overrides: Partial<SpendEvent> = {}): SpendEvent {
  return {
    ts: Date.now(),
    traceId: "test-trace-1",
    sessionId: "test-session",
    provider: "mock",
    model: "mock-llama-3.3-70b",
    reason: "mock mode — no real provider needed",
    usdcCharged: 0.000042,
    inputTokens: 10,
    outputTokens: 25,
    latencyMs: 120,
    paymentMode: "mock",
    cacheHit: false,
    sessionSpent: 0.000042,
    sessionBudget: 5,
    ...overrides,
  };
}

describe("SpendFeed", () => {
  it("renders empty state when no events", () => {
    render(
      <SpendFeed
        events={[]}
        sessionSpent={0}
        sessionBudget={5}
        connected={false}
      />
    );
    expect(screen.getByText("No charges yet")).toBeTruthy();
  });

  it("renders an event with amount and model", () => {
    const event = makeEvent();
    render(
      <SpendFeed
        events={[event]}
        sessionSpent={0.000042}
        sessionBudget={5}
        connected={true}
      />
    );
    // Amount formatted
    expect(screen.getByText("$0.000042")).toBeTruthy();
    // Model name present
    expect(screen.getByText("mock-llama-3.3-70b")).toBeTruthy();
  });

  it("shows settlement tx hash as a link when present", () => {
    const hash = "0xdeadbeef1234567890abcdef";
    const event = makeEvent({
      traceId: "trace-2",
      settlementTxHash: hash,
      paymentMode: "x402-percall",
    });
    render(
      <SpendFeed
        events={[event]}
        sessionSpent={0.000042}
        sessionBudget={5}
        connected={true}
      />
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toContain(hash);
    expect(link.getAttribute("href")).toContain("sepolia.basescan.org");
  });

  it("renders budget progress bar with correct spent/budget labels", () => {
    render(
      <SpendFeed
        events={[]}
        sessionSpent={2.5}
        sessionBudget={5}
        connected={false}
      />
    );
    // Check that the budget text is visible (multiple instances ok across renders)
    expect(screen.getAllByText(/Session spent/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$5\.00/).length).toBeGreaterThan(0);
  });

  it("shows event count", () => {
    const events = [makeEvent(), makeEvent({ traceId: "trace-3" })];
    render(
      <SpendFeed
        events={events}
        sessionSpent={0}
        sessionBudget={5}
        connected={true}
      />
    );
    expect(screen.getByText("2 events")).toBeTruthy();
  });
});
