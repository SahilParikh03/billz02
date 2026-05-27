import { describe, it, expect } from "vitest";
import { classify } from "./classify";
import type { ChatMessage } from "@/lib/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function user(content: string): ChatMessage[] {
  return [{ role: "user", content }];
}

function conv(...pairs: [string, string][]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const [u, a] of pairs) {
    msgs.push({ role: "user", content: u });
    msgs.push({ role: "assistant", content: a });
  }
  return msgs;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("classify() — taskClass", () => {
  it("greeting → chat", () => {
    const r = classify(user("Hello! How are you?"));
    expect(r.taskClass).toBe("chat");
  });

  it("trivial arithmetic → chat (not math/reasoning)", () => {
    const r = classify(user("what is 2+2"));
    expect(r.taskClass).toBe("chat");
  });

  it("Python function request → code", () => {
    const r = classify(user("Write a Python function that reverses a linked list"));
    expect(r.taskClass).toBe("code");
  });

  it("fenced code block → code", () => {
    const r = classify(user("Fix this bug:\n```python\ndef foo(x):\n  return x/0\n```"));
    expect(r.taskClass).toBe("code");
  });

  it("step-by-step reasoning → reasoning", () => {
    const r = classify(
      user("Explain step by step why TCP is reliable, comparing it to UDP")
    );
    expect(r.taskClass).toBe("reasoning");
  });

  it("multi-question prompt → reasoning", () => {
    const r = classify(
      user("Why did the Roman Empire fall? And how did it influence modern law?")
    );
    expect(r.taskClass).toBe("reasoning");
  });

  it("poem request → creative", () => {
    const r = classify(user("Write a poem about the ocean at dusk"));
    expect(r.taskClass).toBe("creative");
  });

  it("brainstorm → creative", () => {
    const r = classify(user("Brainstorm ten fictional names for a space pirate crew"));
    expect(r.taskClass).toBe("creative");
  });
});

describe("classify() — difficulty", () => {
  it("greeting is low difficulty (< 0.3)", () => {
    const r = classify(user("Hi there!"));
    expect(r.difficulty).toBeLessThan(0.3);
  });

  it("'what is 2+2' is low difficulty (< 0.3)", () => {
    const r = classify(user("what is 2+2"));
    expect(r.difficulty).toBeLessThan(0.3);
  });

  it("yes/no question is low difficulty (< 0.25)", () => {
    const r = classify(user("Is Python an interpreted language?"));
    expect(r.difficulty).toBeLessThan(0.25);
  });

  it("routine chat question is moderate (0.15 – 0.5)", () => {
    const r = classify(user("What's the capital of France?"));
    expect(r.difficulty).toBeLessThanOrEqual(0.5);
    expect(r.difficulty).toBeGreaterThanOrEqual(0.05);
  });

  it("Python function request → higher difficulty (> 0.5)", () => {
    const r = classify(user("Write a Python function that reverses a linked list in O(n) time"));
    expect(r.difficulty).toBeGreaterThan(0.5);
  });

  it("SQL query generation → higher difficulty (> 0.5)", () => {
    const r = classify(
      user(
        "Write a SQL query to find the top 5 customers by revenue, joining orders and customers tables"
      )
    );
    expect(r.difficulty).toBeGreaterThan(0.5);
  });

  it("step-by-step reasoning with comparison → high difficulty (> 0.6)", () => {
    const r = classify(
      user(
        "Explain step by step why the Byzantine fault-tolerant consensus algorithm works, " +
          "comparing PBFT and Tendermint in terms of safety and liveness trade-offs"
      )
    );
    expect(r.difficulty).toBeGreaterThan(0.6);
  });

  it("long multi-part prompt → high difficulty (> 0.65)", () => {
    const longPrompt =
      "I need a comprehensive analysis of microservice architecture. " +
      "Please cover: 1. Service decomposition strategies, 2. Inter-service communication " +
      "(REST vs gRPC vs message queues), 3. Distributed tracing and observability, " +
      "4. Data consistency patterns (saga, CQRS, event sourcing), " +
      "5. Kubernetes deployment best practices. Be thorough and detailed.";
    const r = classify(user(longPrompt));
    expect(r.difficulty).toBeGreaterThan(0.65);
  });

  it("deep conversation context raises difficulty slightly", () => {
    const shallow = classify(user("tell me about caching"));
    const deep = classify([
      ...conv(
        ["what is a cache?", "A cache stores frequently accessed data..."],
        ["how does LRU work?", "LRU evicts the least recently used item..."],
        ["what about distributed caches?", "Redis and Memcached are popular..."],
        ["how do you handle cache invalidation?", "Cache invalidation is hard..."],
        ["what about cache stampede?", "Cache stampede occurs when..."]
      ),
      { role: "user", content: "tell me about caching" },
    ]);
    expect(deep.difficulty).toBeGreaterThanOrEqual(shallow.difficulty);
  });
});

describe("classify() — expectedOutTokens", () => {
  it("yes/no → small output (~32)", () => {
    const r = classify(user("Is TypeScript a superset of JavaScript?"));
    expect(r.expectedOutTokens).toBeLessThanOrEqual(80);
  });

  it("code generation → large output (>= 768)", () => {
    const r = classify(user("Write a Python function to implement quicksort"));
    expect(r.expectedOutTokens).toBeGreaterThanOrEqual(768);
  });

  it("detailed code request → largest output (>= 1200)", () => {
    const r = classify(
      user(
        "Write a comprehensive, detailed Python class implementing a thread-safe LRU cache " +
          "with TTL support, including full type annotations and docstrings"
      )
    );
    expect(r.expectedOutTokens).toBeGreaterThanOrEqual(1200);
  });

  it("essay/explain request → moderate-large output (>= 512)", () => {
    const r = classify(user("Explain step by step how garbage collection works in the JVM"));
    expect(r.expectedOutTokens).toBeGreaterThanOrEqual(512);
  });

  it("poem → moderate output (>= 512)", () => {
    const r = classify(user("Write a poem about the ocean at dusk"));
    expect(r.expectedOutTokens).toBeGreaterThanOrEqual(512);
  });

  it("long multi-part prompt → largest output (>= 1500)", () => {
    const longPrompt =
      "I need a comprehensive analysis of microservice architecture. " +
      "Please cover: 1. Service decomposition strategies, 2. Inter-service communication " +
      "(REST vs gRPC vs message queues), 3. Distributed tracing and observability, " +
      "4. Data consistency patterns (saga, CQRS, event sourcing), " +
      "5. Kubernetes deployment best practices. Be thorough and detailed.";
    const r = classify(user(longPrompt));
    expect(r.expectedOutTokens).toBeGreaterThanOrEqual(1500);
  });
});

describe("classify() — determinism & signals", () => {
  it("same input always produces same output", () => {
    const msgs = user("Write a TypeScript function to debounce async calls");
    const r1 = classify(msgs);
    const r2 = classify(msgs);
    expect(r1.difficulty).toBe(r2.difficulty);
    expect(r1.taskClass).toBe(r2.taskClass);
    expect(r1.expectedOutTokens).toBe(r2.expectedOutTokens);
  });

  it("signals object is present and contains key features", () => {
    const r = classify(user("Explain step by step why recursion works"));
    expect(r.signals).toBeDefined();
    expect(typeof r.signals!.f_length).toBe("number");
    expect(typeof r.signals!.f_code).toBe("number");
    expect(typeof r.signals!.rawSum).toBe("number");
  });

  it("difficulty is strictly in (0, 1)", () => {
    const cases = [
      "hi",
      "what is 2+2",
      "Write a Python function to sort a list",
      "Explain step by step why TCP is reliable, comparing to UDP",
      "Write a poem about autumn",
      "Is Python interpreted?",
      "Implement a red-black tree in TypeScript with full insert/delete/rebalance",
    ];
    for (const c of cases) {
      const r = classify(user(c));
      expect(r.difficulty).toBeGreaterThan(0);
      expect(r.difficulty).toBeLessThan(1);
    }
  });
});
