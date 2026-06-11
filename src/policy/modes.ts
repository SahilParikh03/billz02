import type { PolicyMode } from "@/lib/types";

/**
 * Forkable routing policies.
 *
 * Each preset tunes the cascade threshold and the cost/quality trade-off. A mode
 * is resolved per request: an `X-Beamr-Policy` header override → `BEAMR_POLICY_MODE`
 * env → "frugal". This is the dossier's "fork the router policy" lever.
 *
 * The default is `frugal` (Phase A): bias the cheap tier so BEAMR's own spend is
 * minimized unless a caller opts up via the header or `BEAMR_POLICY_MODE`.
 */
export interface PolicyParams {
  /** difficulty ≥ this → strong tier. Higher = cheaper (more to the weak tier). */
  difficultyThreshold: number;
  latencyWeight: number;
  qualityWeight: number;
  /** Bias routing toward models carrying any of these tags (e.g. "uncensored"). */
  preferTags?: string[];
}

const MODES: Record<PolicyMode, PolicyParams> = {
  // Cheapest: high bar to the strong tier; ignore learned quality.
  frugal: { difficultyThreshold: 0.75, latencyWeight: 0, qualityWeight: 0 },
  // Default: cost-led, with a light nudge from learned quality.
  balanced: { difficultyThreshold: 0.5, latencyWeight: 0, qualityWeight: 0.003 },
  // Quality-first: reach the strong tier readily; weight learned quality heavily.
  premium: { difficultyThreshold: 0.25, latencyWeight: 0, qualityWeight: 0.02 },
  // Balanced economics, but prefers uncensored/creative models.
  uncensored: {
    difficultyThreshold: 0.5,
    latencyWeight: 0,
    qualityWeight: 0.003,
    preferTags: ["uncensored"],
  },
};

const ALL = new Set<PolicyMode>(["frugal", "balanced", "premium", "uncensored"]);

function isMode(v: string | undefined | null): v is PolicyMode {
  return v != null && ALL.has(v as PolicyMode);
}

/** Effective mode: per-request override → env → "frugal". */
export function resolvePolicyMode(override?: string | null): PolicyMode {
  if (isMode(override)) return override;
  const env = process.env.BEAMR_POLICY_MODE;
  return isMode(env) ? env : "frugal";
}

export function policyParams(mode: PolicyMode): PolicyParams {
  return MODES[mode];
}
