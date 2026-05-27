import { describe, it, expect } from "vitest";
import { createMockAdapter } from "./mock";
import { getConfig } from "@/lib/config";
import type { CompletionResult } from "@/lib/types";

describe("mock adapter", () => {
  it("streams deltas then a terminal done with a computed charge", async () => {
    const a = createMockAdapter(getConfig());
    const deltas: string[] = [];
    let done: CompletionResult | undefined;

    for await (const ev of a.stream({
      model: "mock-fast",
      messages: [{ role: "user", content: "hello there how are you" }],
    })) {
      if (ev.type === "delta") deltas.push(ev.content);
      if (ev.type === "done") done = ev.result;
    }

    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toBeDefined();
    expect(done!.provider).toBe("mock");
    expect(done!.paymentMode).toBe("mock");
    expect(done!.usdcCharged).toBeGreaterThan(0);
    expect(done!.text).toContain("hello there");
  });

  it("falls back to a known model when given an unknown one", async () => {
    const a = createMockAdapter(getConfig());
    let done: CompletionResult | undefined;
    for await (const ev of a.stream({ model: "nope", messages: [{ role: "user", content: "x" }] })) {
      if (ev.type === "done") done = ev.result;
    }
    expect(done!.model).toBe("mock-fast");
  });
});
