import type { LeaderboardRow as _Row, ProviderId, QueryClass } from "./types";

/**
 * Learned quality priors — the Stage 3 moat.
 *
 * Every thumbs-up/down updates a per-(taskClass, provider, model) win-rate. The
 * router reads these (synchronously) to bias routing toward what users actually
 * prefer for each kind of task — preference data that compounds and can't be copied.
 *
 * State is in-process (read on the hot path must be sync) and mirrored to a JSONL
 * training log by the feedback module. Stage 3+ loads the priors from a shared
 * store at startup; for now they accumulate per process.
 */

interface VoteStat {
  up: number;
  down: number;
}
interface CostStat {
  sum: number;
  n: number;
}
interface QualityState {
  votes: Map<string, VoteStat>; // key: taskClass|provider|model
  costs: Map<string, CostStat>; // key: provider|model
}

const g = globalThis as unknown as { __billzQuality?: QualityState };
function state(): QualityState {
  if (!g.__billzQuality) g.__billzQuality = { votes: new Map(), costs: new Map() };
  return g.__billzQuality;
}

const voteKey = (t: QueryClass, p: ProviderId, m: string) => `${t}|${p}|${m}`;
const costKey = (p: ProviderId, m: string) => `${p}|${m}`;

/** Laplace-smoothed Beta posterior mean of a {up,down} vote stat. */
const winRate = (v: VoteStat) => (v.up + 1) / (v.up + v.down + 2);

export function recordVote(
  taskClass: QueryClass,
  provider: ProviderId,
  model: string,
  up: boolean,
): void {
  const votes = state().votes;
  const k = voteKey(taskClass, provider, model);
  const v = votes.get(k) ?? { up: 0, down: 0 };
  if (up) v.up++;
  else v.down++;
  votes.set(k, v);
}

/** Track per-(provider,model) cost so the leaderboard can rank quality-per-dollar. */
export function recordCost(provider: ProviderId, model: string, usd: number): void {
  const costs = state().costs;
  const k = costKey(provider, model);
  const c = costs.get(k) ?? { sum: 0, n: 0 };
  c.sum += usd;
  c.n++;
  costs.set(k, c);
}

/**
 * Learned win-rate for a (task, provider, model), or undefined when there are no
 * votes yet (so the scorer falls back to the static prior). Synchronous by design.
 */
export function learnedQuality(
  taskClass: QueryClass,
  provider: ProviderId,
  model: string,
): number | undefined {
  const v = state().votes.get(voteKey(taskClass, provider, model));
  if (!v || v.up + v.down === 0) return undefined;
  return winRate(v);
}

export type LeaderboardRow = _Row;

/** Quality-per-dollar leaderboard, descending. */
export function leaderboard(): LeaderboardRow[] {
  const { votes, costs } = state();
  const rows: LeaderboardRow[] = [];
  for (const [k, v] of votes) {
    const [taskClass, provider, model] = k.split("|") as [QueryClass, ProviderId, string];
    const samples = v.up + v.down;
    const wr = winRate(v);
    const c = costs.get(costKey(provider, model));
    const avgCostUsd = c && c.n ? c.sum / c.n : 0;
    rows.push({
      taskClass,
      provider,
      model,
      up: v.up,
      down: v.down,
      winRate: wr,
      avgCostUsd,
      qualityPerDollar: avgCostUsd > 0 ? wr / avgCostUsd : 0,
      samples,
    });
  }
  rows.sort((a, b) => b.qualityPerDollar - a.qualityPerDollar);
  return rows;
}

export function resetQuality(): void {
  g.__billzQuality = undefined;
}
