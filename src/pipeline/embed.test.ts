import { describe, it, expect } from "vitest";
import { createLocalEmbedder, cosine } from "./embed";

const embedder = createLocalEmbedder(256);

describe("createLocalEmbedder", () => {
  it("returns correct id and dim", () => {
    expect(embedder.id).toBe("local-fnv1a-256d");
    expect(embedder.dim).toBe(256);
  });

  it("is deterministic: same text always produces the same vector", async () => {
    const text = "What is the capital of France?";
    const v1 = await embedder.embed(text);
    const v2 = await embedder.embed(text);
    expect(v1).toEqual(v2);
  });

  it("produces an L2-normalized vector (‖v‖ ≈ 1)", async () => {
    const v = await embedder.embed("Explain quantum entanglement simply.");
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1, 5);
  });

  it("cosine of identical text ≈ 1", async () => {
    const text = "How do I reverse a linked list in Python?";
    const v = await embedder.embed(text);
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it("cosine of completely unrelated texts is low", async () => {
    const v1 = await embedder.embed("What is the capital of France?");
    const v2 = await embedder.embed(
      "Write a quicksort implementation in Rust.",
    );
    const sim = cosine(v1, v2);
    // Unrelated topics should share few tokens; similarity should be well below threshold
    expect(sim).toBeLessThan(0.75);
  });

  it("near-duplicate (extra whitespace) has high cosine similarity (> 0.83)", async () => {
    const base = await embedder.embed("What is the capital of France?");
    const spacey = await embedder.embed(
      "  What   is  the  capital  of   France?  ",
    );
    expect(cosine(base, spacey)).toBeGreaterThan(0.83);
  });

  it("near-duplicate (trailing punctuation changed) has high cosine similarity (> 0.83)", async () => {
    const v1 = await embedder.embed("What is the capital of France?");
    const v2 = await embedder.embed("What is the capital of France!");
    expect(cosine(v1, v2)).toBeGreaterThan(0.83);
  });

  it("near-duplicate (one word changed) has high cosine similarity (> 0.83)", async () => {
    const v1 = await embedder.embed("What is the capital of France?");
    const v2 = await embedder.embed("What is the capital of Germany?");
    expect(cosine(v1, v2)).toBeGreaterThan(0.83);
  });

  it("cosine(a, b) returns 0 for zero-length equal-magnitude check on unit vectors", async () => {
    // Sanity check: cosine helper with explicit arrays
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it("cosine(a, b) returns 0 when both vectors are zero-mag", () => {
    expect(cosine([0, 0, 0], [0, 0, 0])).toBe(0);
  });
});
