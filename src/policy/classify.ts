/**
 * BILLZ difficulty classifier — Stage 1.
 *
 * Deterministic, dependency-free, in-process. Target: < 2 ms per call.
 *
 * Design
 * ──────
 * 1. Extract the last user message (primary signal) plus coarse conversation
 *    context (total message count, prior assistant turns).
 * 2. Run regex / keyword passes to produce named numeric features (all 0..1 or
 *    small positive integers — kept as named constants so they're tunable).
 * 3. Classify taskClass: code > reasoning > creative > chat, in priority order.
 * 4. Score difficulty as a weighted sum of features — including a taskClass
 *    contribution, since code/reasoning are inherently harder than chat — then
 *    squash through a logistic so the output is always in (0,1).
 * 5. Estimate expectedOutTokens from taskClass + depth signals.
 * 6. Return signals map for transparency / downstream learning.
 */

import type { ChatMessage, Classification, QueryClass } from "@/lib/types";

// ── Feature weights (tunable) ─────────────────────────────────────────────────

/** Weight on raw prompt character length, normalized to [0,1] by LOG_LEN_SCALE. */
const W_LENGTH = 0.18;
/** Natural-log denominator: ln(2000) ≈ 7.6 → prompts > 2000 chars score near 1. */
const LOG_LEN_SCALE = 7.6;

/** Weight on code-signal presence (0 or 1). */
const W_CODE = 0.22;

/** Weight on math-signal presence (0 or 1). */
const W_MATH = 0.14;

/** Weight on multi-step / multi-question markers (0 or 1). */
const W_MULTISTEP = 0.28;

/** Weight on depth-request keywords ("in detail", "comprehensive", etc.). */
const W_DEPTH = 0.12;

/** Weight on technical-vocabulary density (fraction of words that are domain terms). */
const W_TECHVOCAB = 0.10;

/** Weight on conversation depth (number of prior turns, normalized). */
const W_CONVDEPTH = 0.08;

/**
 * Weight on the task class itself. Code/reasoning prompts are intrinsically
 * harder than chat regardless of length, so the class contributes directly —
 * otherwise a terse "prove √2 is irrational" scores as easy as a greeting.
 */
const W_TASKCLASS = 0.25;
/** Per-class intrinsic difficulty (0..1), scaled by W_TASKCLASS. */
const TASKCLASS_DIFFICULTY: Record<QueryClass, number> = {
  code: 1.0,
  reasoning: 1.0,
  creative: 0.4,
  chat: 0.0,
};

/**
 * Logistic steepness: controls how sharply the difficulty curve rises.
 * Tuned (with X0) so simple chat lands ~0.22, medium reasoning ~0.5, and hard
 * code/multi-step prompts clear the frugal strong-tier threshold (0.75).
 */
const LOGISTIC_K = 4.8;
/** Logistic midpoint: raw weighted sum at which difficulty ≈ 0.5. */
const LOGISTIC_X0 = 0.365;

/** Trivial inputs (greetings, yes/no, short factual lookups) cap out here. */
const TRIVIAL_CEILING = 0.18;

// ── Token-estimate anchors ────────────────────────────────────────────────────

const TOKENS_YESNO = 32;
const TOKENS_SHORT_FACTUAL = 80;
const TOKENS_DEFAULT_CHAT = 256;
const TOKENS_EXPLAIN = 512;
const TOKENS_CODE_SIMPLE = 768;
const TOKENS_CODE_DETAILED = 1200;
const TOKENS_LONG_ESSAY = 1500;

// ── Regex patterns ────────────────────────────────────────────────────────────

// Code signals
const RE_FENCED_CODE = /```[\s\S]*?```|`[^`\n]{2,}`/;
const RE_CODE_KEYWORDS =
  /\b(function|def\s+\w|class\s+\w|import\s+\w|export\s+|const\s+|let\s+|var\s+|return\s+|async\s+|await\s+|lambda\s*:|=>|->)\b/i;
const RE_LANG_NAMES =
  /\b(python|javascript|typescript|java|kotlin|swift|rust|go|golang|c\+\+|cpp|sql|bash|shell|regex|html|css|json|yaml|graphql|solidity|ruby|scala)\b/i;
const RE_BUG_TRACE =
  /\b(bug|stack\s*trace|compile[dr]?|syntax\s*error|runtime\s*error|exception|traceback|segfault|undefined\s+(variable|function|method)|null\s*pointer|type\s*error)\b/i;
const RE_WRITE_CODE =
  /\b(write|implement|create|build|generate|code|script)\b.*\b(function|method|class|component|api|endpoint|algorithm|program)\b/i;

// Reasoning signals
const RE_REASONING =
  /\b(why|prove|proof|derive|step[- ]by[- ]step|analyze|analyse|explain\s+how|trade[- ]?off[s]?|compare|contrast|pros\s+and\s+cons|evaluate|assess|reason|justify|demonstrate|what\s+causes?|how\s+does\s+.{0,30}\s+work)\b/i;
const RE_MULTI_QUESTION = /\?.*\?|\b(?:and\s+also|furthermore|additionally|firstly|secondly|thirdly)\b|[:\s][ab]\)\s*\w|[:\s][12]\.\s+\w/i;
const RE_MATH =
  /\b(calcul|integral|derivative|equation|theorem|proof|algebra|geometry|trigonometry|probability|statistic|matrix|vector|eigenvalu)\b|[∑∫∂√π≤≥≠∞±×÷]|\b\d+\s*[\+\-\*\/\^]\s*\d+\b.*\b(factor|simplify|solve|compute)\b/i;

// Creative signals
const RE_CREATIVE =
  /\b(write\s+a\s+(poem|story|song|haiku|sonnet|essay|script|narrative|dialogue|letter)|imagine|fictional|brainstorm|in\s+the\s+style\s+of|creative|once\s+upon\s+a\s+time|make\s+up|invent)\b/i;

// Depth signals
const RE_DEPTH =
  /\b(in\s+detail|detailed|comprehensive|thoroughly|thorough|exhaustive|complete\s+(analysis|guide|overview)|at\s+length|explain\s+everything|tell\s+me\s+everything|deep\s+(dive|analysis)|full\s+explanation)\b/i;

// Yes/no short-answer signals
const RE_YESNO =
  /^(is|are|was|were|does|do|did|has|have|had|can|could|should|would|will|may|might)\s+.{0,80}\??$/i;
const RE_SHORT_FACTUAL =
  /^(what\s+is|what's|who\s+is|who's|when\s+is|where\s+is|how\s+many|how\s+much|define\s+|what\s+does\s+.{0,30}\s+mean)\s+.{0,120}\??$/i;

// Multi-step markers — note: no trailing \b on patterns ending with \w (avoids mid-word boundary fail)
const RE_MULTISTEP =
  /\b(?:step[- ]by[- ]step|part\s+[1-9]|section\s+[1-9]|multiple\s+(?:questions?|parts?)|several\s+(?:questions?|parts?))\b|\b(?:first[,.]|second[,.]|then[,.]|finally[,.])|[:\s]\d+\.\s+\w|\n\s*[-*]\s+\w|\n\s*\d+\.\s+\w/i;

// Technical vocabulary (a sampled, broad set of domain terms)
const TECH_VOCAB_RE =
  /\b(algorithm|complexity|O\([^)]+\)|cache|latency|throughput|concurren|asynchronous|synchronous|mutex|semaphore|deadlock|race\s+condition|memory\s+(leak|management)|garbage\s+collect|heap|stack|pointer|reference|dereference|polymorphism|encapsulation|abstraction|inheritance|interface|protocol|API|REST|GraphQL|websocket|HTTP[S2]?|TCP|UDP|DNS|TLS|SSL|encryption|decryption|hash|cryptograph|neural\s+network|machine\s+learning|gradient|backprop|embedding|transformer|attention|token|semantic|vector\s+space|database|schema|index|query|transaction|ACID|normali[sz]|shard|replicat|microservice|containeriz|kubernetes|docker|CI\/CD|deploy|infrastructure|cloud|serverless)\b/i;

// ── Helper: logistic squash ───────────────────────────────────────────────────

function logistic(x: number, k: number, x0: number): number {
  return 1 / (1 + Math.exp(-k * (x - x0)));
}

// ── Helper: count technical vocabulary density ────────────────────────────────

function techVocabDensity(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  // Count matches (each match counts once regardless of length)
  const matches = (text.match(new RegExp(TECH_VOCAB_RE.source, "gi")) || []).length;
  // Normalize: 3+ technical terms in a sentence is high density; cap at 1.
  return Math.min(1, matches / Math.max(1, words.length * 0.15));
}

// ── Main classifier ───────────────────────────────────────────────────────────

export function classify(messages: ChatMessage[]): Classification {
  // ── 1. Extract primary text ───────────────────────────────────────────────

  const userMessages = messages.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1]?.content ?? "";
  const allText = messages.map((m) => m.content).join(" ");
  const convTurns = messages.length;

  const text = lastUser; // primary signal
  const textLower = text.toLowerCase();

  // ── 2. Feature extraction ─────────────────────────────────────────────────

  // f_length: normalized log of character count (0..1)
  const f_length = Math.min(1, Math.log1p(text.length) / LOG_LEN_SCALE);

  // f_code: any code signal present
  const hasCodeFence = RE_FENCED_CODE.test(text);
  const hasCodeKw = RE_CODE_KEYWORDS.test(text);
  const hasLang = RE_LANG_NAMES.test(textLower);
  const hasBugTrace = RE_BUG_TRACE.test(textLower);
  const hasWriteCode = RE_WRITE_CODE.test(textLower);
  const f_code = hasCodeFence || hasCodeKw || hasLang || hasBugTrace || hasWriteCode ? 1 : 0;

  // f_math: math signal
  const f_math = RE_MATH.test(text) ? 1 : 0;

  // f_multistep: multi-step or multi-question markers
  const hasMultiQ = RE_MULTI_QUESTION.test(text);
  const hasMultiStep = RE_MULTISTEP.test(text);
  const f_multistep = hasMultiQ || hasMultiStep ? 1 : 0;

  // f_depth: depth-request keywords
  const f_depth = RE_DEPTH.test(textLower) ? 1 : 0;

  // f_techvocab: technical vocabulary density (0..1)
  const f_techvocab = techVocabDensity(allText);

  // f_convdepth: conversation depth, normalized (0..1, saturates at ~10 turns)
  const f_convdepth = Math.min(1, convTurns / 10);

  // ── 3. Classify taskClass ─────────────────────────────────────────────────

  let taskClass: QueryClass;

  if (f_code === 1) {
    taskClass = "code";
  } else if (RE_REASONING.test(textLower) || f_math === 1 || hasMultiQ) {
    taskClass = "reasoning";
  } else if (RE_CREATIVE.test(textLower)) {
    taskClass = "creative";
  } else {
    taskClass = "chat";
  }

  // ── 4. Difficulty score ───────────────────────────────────────────────────

  // f_taskclass: intrinsic difficulty of the task class (0..1)
  const f_taskclass = TASKCLASS_DIFFICULTY[taskClass];

  const rawSum =
    W_LENGTH    * f_length    +
    W_CODE      * f_code      +
    W_MATH      * f_math      +
    W_MULTISTEP * f_multistep +
    W_DEPTH     * f_depth     +
    W_TECHVOCAB * f_techvocab +
    W_CONVDEPTH * f_convdepth +
    W_TASKCLASS * f_taskclass;

  // Apply ceiling for trivial inputs (greetings, yes/no) after logistic.
  // A short chat turn is only "trivial" early on — mid-conversation it may be a
  // terse follow-up to a deep thread, so don't cap once the dialogue has depth.
  const isYesNo = RE_YESNO.test(text.trim());
  const isShortFactual = RE_SHORT_FACTUAL.test(text.trim());
  const isTrivial =
    isYesNo ||
    isShortFactual ||
    (text.trim().length < 30 && taskClass === "chat" && convTurns <= 2);

  let difficulty = logistic(rawSum, LOGISTIC_K, LOGISTIC_X0);

  // Clamp trivial answers toward the low end without a hard floor
  if (isTrivial) difficulty = Math.min(difficulty, TRIVIAL_CEILING);

  // ── 5. Expected output tokens ─────────────────────────────────────────────

  let expectedOutTokens: number;

  if (isYesNo) {
    expectedOutTokens = TOKENS_YESNO;
  } else if (isShortFactual && text.length < 80) {
    expectedOutTokens = TOKENS_SHORT_FACTUAL;
  } else if (taskClass === "code") {
    expectedOutTokens =
      f_depth === 1 || text.length > 400
        ? TOKENS_CODE_DETAILED
        : TOKENS_CODE_SIMPLE;
  } else if (taskClass === "reasoning") {
    expectedOutTokens =
      f_depth === 1 || hasMultiStep ? TOKENS_LONG_ESSAY : TOKENS_EXPLAIN;
  } else if (taskClass === "creative") {
    expectedOutTokens = f_depth === 1 ? TOKENS_LONG_ESSAY : TOKENS_EXPLAIN;
  } else {
    // chat
    if (isTrivial) {
      expectedOutTokens = text.trim().length < 10 ? TOKENS_YESNO : TOKENS_SHORT_FACTUAL;
    } else if (f_depth === 1) {
      expectedOutTokens = TOKENS_EXPLAIN;
    } else {
      expectedOutTokens = TOKENS_DEFAULT_CHAT;
    }
  }

  // ── 6. Signals (interpretable features) ──────────────────────────────────

  const signals: Record<string, number> = {
    f_length,
    f_code,
    f_math,
    f_multistep,
    f_depth,
    f_techvocab,
    f_convdepth,
    f_taskclass,
    rawSum,
    isTrivial: isTrivial ? 1 : 0,
  };

  return { difficulty, taskClass, expectedOutTokens, signals };
}
