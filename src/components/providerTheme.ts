/**
 * Per-provider accent palette. Each terminal pane is color-coded by the provider
 * its pinned model belongs to (the "CodeGrid" look — see public/img_01.png), so the
 * class strings are written out in full for Tailwind's JIT to pick them up.
 */

export interface Accent {
  /** key, also the legend label */
  name: string;
  /** header/title text color */
  text: string;
  /** pane + header border color */
  border: string;
  /** subtle header background tint */
  headerBg: string;
  /** solid status dot */
  dot: string;
  /** focus ring tint */
  ring: string;
  /** raw-ish hex for box-shadow glow (focused pane) */
  glow: string;
}

const THEME: Record<string, Accent> = {
  hyperbolic: {
    name: "hyperbolic",
    text: "text-sky-300",
    border: "border-sky-500/40",
    headerBg: "bg-sky-500/10",
    dot: "bg-sky-400",
    ring: "ring-sky-500/40",
    glow: "rgba(56,189,248,0.25)",
  },
  surplus: {
    name: "surplus",
    text: "text-emerald-300",
    border: "border-emerald-500/40",
    headerBg: "bg-emerald-500/10",
    dot: "bg-emerald-400",
    ring: "ring-emerald-500/40",
    glow: "rgba(52,211,153,0.25)",
  },
  venice: {
    name: "venice",
    text: "text-violet-300",
    border: "border-violet-500/40",
    headerBg: "bg-violet-500/10",
    dot: "bg-violet-400",
    ring: "ring-violet-500/40",
    glow: "rgba(167,139,250,0.25)",
  },
  anthropic: {
    name: "anthropic",
    text: "text-orange-300",
    border: "border-orange-500/40",
    headerBg: "bg-orange-500/10",
    dot: "bg-orange-400",
    ring: "ring-orange-500/40",
    glow: "rgba(251,146,60,0.25)",
  },
  mock: {
    name: "mock",
    text: "text-amber-300",
    border: "border-amber-500/40",
    headerBg: "bg-amber-500/10",
    dot: "bg-amber-400",
    ring: "ring-amber-500/40",
    glow: "rgba(251,191,36,0.22)",
  },
  auto: {
    name: "auto",
    text: "text-fuchsia-300",
    border: "border-fuchsia-500/40",
    headerBg: "bg-fuchsia-500/10",
    dot: "bg-fuchsia-400",
    ring: "ring-fuchsia-500/40",
    glow: "rgba(232,121,249,0.25)",
  },
};

export function providerAccent(provider?: string): Accent {
  return THEME[provider ?? "mock"] ?? THEME.mock;
}
