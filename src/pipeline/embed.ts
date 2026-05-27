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
 * model download is required.
 *
 * UPGRADE PATH: A MiniLM backend (e.g. `@xenova/transformers`) can replace
 * this entire implementation by returning an object that satisfies the
 * `Embedder` interface:
 *
 *   import { pipeline } from "@xenova/transformers";
 *   const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
 *   export function createMiniLMEmbedder(): Embedder {
 *     return {
 *       id: "minilm-l6-v2",
 *       dim: 384,
 *       async embed(text: string): Promise<number[]> {
 *         const out = await extractor(text, { pooling: "mean", normalize: true });
 *         return Array.from(out.data as Float32Array);
 *       },
 *     };
 *   }
 *
 * No changes to cache.ts or any call-site are needed — just swap the factory.
 */

import type { Embedder } from "@/lib/types";

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
