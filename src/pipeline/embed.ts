/**
 * Local zero-dependency text embedder (GPTCache-style).
 *
 * Algorithm:
 *  1. Normalize text: lowercase + collapse whitespace.
 *  2. Extract tokens: word unigrams AND char 3-grams.
 *  3. Hash each token into a bucket in [0, dim) using FNV-1a 32-bit.
 *  4. Accumulate TF (term-frequency) counts in a Float64 vector.
 *  5. L2-normalize the vector so cosine similarity = dot product.
 *
 * The resulting embeddings are deterministic and offline — no network or
 * model download is required. It is the default backend.
 *
 * A higher-quality MiniLM backend ({@link createMiniLmEmbedder}) is selectable
 * via `BEAMR_EMBEDDER=minilm`; {@link getEmbedder} dispatches on the cache
 * config. Both satisfy the same {@link Embedder} interface, so cache.ts and
 * every call-site are agnostic to which is active.
 */

import type { AppConfig, Embedder, EmbedderKind } from "@/lib/types";

/**
 * FNV-1a 32-bit hash. Returns an unsigned 32-bit integer.
 * Chosen for its excellent avalanche on short strings and extreme simplicity.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // Multiply by FNV prime (0x01000193) with 32-bit wrap using >>> 0
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Normalize text for embedding: lowercase + collapse whitespace.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Extract word unigrams and character 3-grams from normalized text.
 * The combination gives good token-level and subword-level coverage.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // Word unigrams
  const words = text.split(" ").filter((w) => w.length > 0);
  for (const w of words) {
    tokens.push(`w:${w}`);
  }

  // Character 3-grams over the full string (spaces included for boundary info)
  for (let i = 0; i + 2 < text.length; i++) {
    tokens.push(`c:${text.slice(i, i + 3)}`);
  }

  return tokens;
}

/**
 * Compute cosine similarity between two L2-normalized vectors.
 * For L2-normalized vectors this is equivalent to the dot product, but we
 * compute it explicitly for safety when vectors might not be perfectly
 * normalized (e.g. the zero vector).
 *
 * Returns a value in [-1, 1]; returns 0 if either vector has zero magnitude.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Create a local embedder with `dim`-dimensional output.
 *
 * @param dim - Vector dimensionality. 256 is the default; higher dims reduce
 *   hash-collision rate at the cost of memory. Must be ≥ 1.
 */
export function createLocalEmbedder(dim = 256): Embedder {
  return {
    id: `local-fnv1a-${dim}d`,
    dim,

    async embed(text: string): Promise<number[]> {
      const normalized = normalize(text);
      const tokens = tokenize(normalized);
      const vec = new Float64Array(dim);

      for (const token of tokens) {
        const bucket = fnv1a32(token) % dim;
        // Weight word unigrams (prefix "w:") 5× vs char 3-grams (prefix "c:") 1×.
        // This ensures that when most words match but one differs, the shared
        // words dominate the vector — yielding higher cosine for near-duplicates.
        vec[bucket] += token.startsWith("w:") ? 5 : 1;
      }

      // L2 normalize
      let mag = 0;
      for (let i = 0; i < dim; i++) mag += vec[i] * vec[i];
      mag = Math.sqrt(mag);

      if (mag === 0) {
        // Zero vector — return uniform unit vector
        const v = new Array<number>(dim).fill(1 / Math.sqrt(dim));
        return v;
      }

      const result = new Array<number>(dim);
      for (let i = 0; i < dim; i++) result[i] = vec[i] / mag;
      return result;
    },
  };
}

// ── MiniLM backend (@huggingface/transformers) ────────────────────────────────

/** Default sentence-embedding model: all-MiniLM-L6-v2, 384-dimensional. */
const MINILM_MODEL = process.env.BEAMR_MINILM_MODEL || "Xenova/all-MiniLM-L6-v2";
const MINILM_DIM = 384;

// Minimal structural types for the lazily-imported transformers pipeline, so we
// don't take a compile-time dependency on the optional package's types.
type FeatureTensor = { data: Float32Array | number[] };
type FeatureExtractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureTensor>;

/**
 * MiniLM sentence embedder via `@huggingface/transformers` (an optional
 * dependency, auto-externalized by Next so it runs under native Node `require`).
 *
 * The feature-extraction pipeline is built lazily and memoized on first
 * `embed()` — building it downloads the ONNX model on the first ever call
 * (cached on disk thereafter), so the heavy package and the network fetch only
 * happen when `BEAMR_EMBEDDER=minilm` is actually selected. Mean-pooled +
 * L2-normalized output, so cosine() behaves identically to the local backend.
 */
export function createMiniLmEmbedder(model = MINILM_MODEL): Embedder {
  let extractorPromise: Promise<FeatureExtractor> | null = null;

  async function getExtractor(): Promise<FeatureExtractor> {
    if (!extractorPromise) {
      extractorPromise = (async () => {
        let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
        try {
          mod = (await import("@huggingface/transformers")) as typeof mod;
        } catch {
          throw new Error(
            "embed: BEAMR_EMBEDDER=minilm requires @huggingface/transformers. " +
              "Install it with `npm install @huggingface/transformers`, or set " +
              "BEAMR_EMBEDDER=local to use the offline embedder.",
          );
        }
        return (await mod.pipeline("feature-extraction", model)) as FeatureExtractor;
      })();
      // If building the pipeline fails, clear the memo so a later call can retry.
      extractorPromise.catch(() => {
        extractorPromise = null;
      });
    }
    return extractorPromise;
  }

  return {
    id: `minilm:${model}`,
    dim: MINILM_DIM,
    async embed(text: string): Promise<number[]> {
      const extractor = await getExtractor();
      const out = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(out.data);
    },
  };
}

// ── Selection ──────────────────────────────────────────────────────────────

/**
 * Build the embedder for the given cache config. Defaults to the local
 * backend; returns the MiniLM backend when `cache.embedder === "minilm"`.
 */
export function getEmbedder(cacheCfg?: Pick<AppConfig["cache"], "embedder">): Embedder {
  const kind: EmbedderKind = cacheCfg?.embedder === "minilm" ? "minilm" : "local";
  return kind === "minilm" ? createMiniLmEmbedder() : createLocalEmbedder(256);
}
