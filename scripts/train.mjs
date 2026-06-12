#!/usr/bin/env node
/**
 * BEAMR training-data CLI — scripts/train.mjs
 *
 * Reads .beamr/feedback.jsonl, aggregates per (taskClass, provider, model),
 * prints a quality-per-dollar leaderboard, and writes the exportable preference
 * dataset to .beamr/training-dataset.json.
 *
 * Usage:  node scripts/train.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const FEEDBACK_PATH = join(".beamr", "feedback.jsonl");
const OUTPUT_PATH = join(".beamr", "training-dataset.json");

// ── Load feedback log ──────────────────────────────────────────────────────────

if (!existsSync(FEEDBACK_PATH)) {
  console.log(
    "\nNo feedback collected yet — chat and vote first.\n" +
      `(Expected file: ${FEEDBACK_PATH})\n`,
  );
  process.exit(0);
}

const raw = await readFile(FEEDBACK_PATH, "utf8");
const lines = raw.split("\n").filter((l) => l.trim().length > 0);

if (lines.length === 0) {
  console.log("\nFeedback file is empty — chat and vote first.\n");
  process.exit(0);
}

/** @type {Array<{traceId:string, taskClass:string, provider:string, model:string, usdcCharged:number, rating:"up"|"down", ts:number}>} */
const rows = [];
for (const [i, line] of lines.entries()) {
  try {
    rows.push(JSON.parse(line));
  } catch {
    console.warn(`  Warning: skipping malformed line ${i + 1}`);
  }
}

// ── Aggregate ──────────────────────────────────────────────────────────────────

/**
 * @typedef {{ up: number; down: number; costSum: number; costN: number }} Agg
 * @type {Map<string, Agg>}
 */
const agg = new Map();

for (const row of rows) {
  const { taskClass, provider, model, usdcCharged, rating } = row;
  if (!taskClass || !provider || !model) continue;

  const key = `${taskClass}|${provider}|${model}`;
  const entry = agg.get(key) ?? { up: 0, down: 0, costSum: 0, costN: 0 };

  if (rating === "up") entry.up++;
  else if (rating === "down") entry.down++;

  const cost = typeof usdcCharged === "number" && usdcCharged >= 0 ? usdcCharged : 0;
  entry.costSum += cost;
  entry.costN++;

  agg.set(key, entry);
}

// ── Build leaderboard rows ─────────────────────────────────────────────────────

/** Laplace-smoothed win-rate — matches quality.ts */
const winRate = (up, down) => (up + 1) / (up + down + 2);

const leaderboard = [];
for (const [key, { up, down, costSum, costN }] of agg) {
  const [taskClass, provider, model] = key.split("|");
  const samples = up + down;
  const wr = winRate(up, down);
  const avgCostUsd = costN > 0 ? costSum / costN : 0;
  const qualityPerDollar = avgCostUsd > 0 ? wr / avgCostUsd : 0;

  leaderboard.push({
    taskClass,
    provider,
    model,
    up,
    down,
    winRate: wr,
    avgCostUsd,
    qualityPerDollar,
    samples,
  });
}

// Sort descending by quality-per-dollar (then by samples for ties)
leaderboard.sort(
  (a, b) =>
    b.qualityPerDollar - a.qualityPerDollar || b.samples - a.samples,
);

// ── Print leaderboard ──────────────────────────────────────────────────────────

const COL = {
  rank: 4,
  model: 28,
  task: 12,
  provider: 12,
  win: 8,
  cost: 10,
  qpd: 12,
  samples: 8,
};

const pad = (s, n, right = false) => {
  const str = String(s);
  const diff = n - str.length;
  if (diff <= 0) return str.slice(0, n);
  return right ? " ".repeat(diff) + str : str + " ".repeat(diff);
};

const hr = "─".repeat(
  COL.rank + COL.model + COL.task + COL.provider + COL.win + COL.cost + COL.qpd + COL.samples + 7,
);

console.log(`\nBEAMR Quality Leaderboard  (${rows.length} votes from ${FEEDBACK_PATH})\n`);
console.log(hr);
console.log(
  pad("#", COL.rank) +
    pad("Model", COL.model) +
    pad("Task", COL.task) +
    pad("Provider", COL.provider) +
    pad("Win%", COL.win, true) +
    pad("AvgCost$", COL.cost, true) +
    pad("Quality/$", COL.qpd, true) +
    pad("Votes", COL.samples, true),
);
console.log(hr);

for (const [i, row] of leaderboard.entries()) {
  console.log(
    pad(i + 1, COL.rank) +
      pad(row.model, COL.model) +
      pad(row.taskClass, COL.task) +
      pad(row.provider, COL.provider) +
      pad((row.winRate * 100).toFixed(1) + "%", COL.win, true) +
      pad(
        row.avgCostUsd > 0 ? "$" + row.avgCostUsd.toFixed(5) : "—",
        COL.cost,
        true,
      ) +
      pad(
        row.qualityPerDollar > 0 ? row.qualityPerDollar.toFixed(2) : "—",
        COL.qpd,
        true,
      ) +
      pad(row.samples, COL.samples, true),
  );
}
console.log(hr);
console.log(`\nTotal labeled examples: ${rows.length}\n`);

// ── Write training dataset ─────────────────────────────────────────────────────

const dataset = {
  generatedAt: new Date().toISOString(),
  totalVotes: rows.length,
  leaderboard,
  /** Raw preference pairs for fine-tuning / RLHF pipelines */
  examples: rows.map((r) => ({
    traceId: r.traceId,
    taskClass: r.taskClass,
    provider: r.provider,
    model: r.model,
    usdcCharged: r.usdcCharged,
    rating: r.rating,
    label: r.rating === "up" ? 1 : 0,
    ts: r.ts,
  })),
};

await mkdir(".beamr", { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(dataset, null, 2));
console.log(`Training dataset written to ${OUTPUT_PATH}\n`);
