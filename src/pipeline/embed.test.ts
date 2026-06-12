import { describe, it, expect } from "vitest";
import { createLocalEmbedder, createMiniLmEmbedder, getEmbedder, cosine } from "./embed";

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

describe("getEmbedder — backend selection", () => {
  it("defaults to the local backend when no embedder is configured", () => {
    expect(getEmbedder().id).toBe("local-fnv1a-256d");
    expect(getEmbedder({ embedder: undefined }).id).toBe("local-fnv1a-256d");
    expect(getEmbedder({ embedder: "local" }).dim).toBe(256);
  });

  it("selects the MiniLM backend when embedder is 'minilm'", () => {
    const e = getEmbedder({ embedder: "minilm" });
    expect(e.id).toContain("minilm");
    expect(e.dim).toBe(384);
  });
});

describe("createMiniLmEmbedder — metadata (no model download)", () => {
  // We don't invoke embed() here: that would download the ONNX model from the
  // HF hub. We only assert the embedder's shape/identity, which is offline.
  it("reports id and 384-d without loading the model", () => {
    const e = createMiniLmEmbedder();
    expect(e.id).toBe("minilm:Xenova/all-MiniLM-L6-v2");
    expect(e.dim).toBe(384);
    expect(typeof e.embed).toBe("function");
  });

  it("honors a custom model id", () => {
    expect(createMiniLmEmbedder("Xenova/bge-small-en-v1.5").id).toBe(
      "minilm:Xenova/bge-small-en-v1.5",
    );
  });
});

// Opt-in: downloads the ONNX model from the HF hub on first run. Enable with
// BEAMR_TEST_MINILM=1 (and @huggingface/transformers installed). Skipped by
// default so the suite stays offline and fast.
describe.runIf(process.env.BEAMR_TEST_MINILM === "1")(
  "MiniLM embedder — live (network)",
  () => {
    it(
      "produces 384-d vectors with high near-dup / low unrelated cosine",
      async () => {
        const e = getEmbedder({ embedder: "minilm" });
        const a = await e.embed("What is the capital of France?");
        const b = await e.embed("What's the capital city of France?");
        const c = await e.embed("Write a quicksort implementation in Rust.");
        expect(a.length).toBe(384);
        expect(e.dim).toBe(384);
        expect(cosine(a, b)).toBeGreaterThan(0.8); // semantic near-duplicate
        expect(cosine(a, c)).toBeLessThan(0.5); // unrelated topic
      },
      120_000,
    );
  },
);
