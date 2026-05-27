import type {
  AppConfig,
  CompletionResult,
  ModelInfo,
  PricePrior,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "@/lib/types";

/**
 * Offline mock provider.
 *
 * Lets the entire pipeline — routing, streaming, budget enforcement, and the
 * live spend feed — be exercised end-to-end with no wallet and no network.
 * It streams a canned reply token-by-token and reports a simulated USDC charge
 * derived from approximate token counts and the model's price prior.
 */

const MODELS: ModelInfo[] = [
  {
    id: "mock-fast",
    label: "Mock Fast",
    inputPricePerM: 0.09,
    outputPricePerM: 0.25,
    contextTokens: 32_000,
    tags: ["fast", "cheap", "chat"],
  },
  {
    id: "mock-strong",
    label: "Mock Strong",
    inputPricePerM: 3.75,
    outputPricePerM: 18.75,
    contextTokens: 128_000,
    tags: ["reasoning", "chat"],
  },
];

/** Rough token estimate (~1.3 tokens per whitespace word). */
function approxTokens(s: string): number {
  return Math.max(1, Math.round(s.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

export function createMockAdapter(_cfg: AppConfig): ProviderAdapter {
  const models = () => MODELS;

  const priceFor = (model: string): PricePrior | undefined => {
    const m = MODELS.find((x) => x.id === model) ?? MODELS[0];
    return { inputPricePerM: m.inputPricePerM, outputPricePerM: m.outputPricePerM };
  };

  const supports = (model: string) =>
    model.startsWith("mock") || MODELS.some((m) => m.id === model);

  async function* stream(
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const start = Date.now();
    const model = supports(req.model) ? req.model : "mock-fast";
    const price = priceFor(model)!;
    const lastUser =
      [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    const reply =
      `[mock:${model}] You said: "${lastUser.slice(0, 160)}". ` +
      `This is a simulated streamed response from the BILLZ mock provider, so the ` +
      `full pipeline — routing, streaming, the session budget, and the live spend ` +
      `feed — can be exercised with no wallet and no network.`;

    let text = "";
    for (const word of reply.split(" ")) {
      if (req.signal?.aborted) break;
      const chunk = (text ? " " : "") + word;
      text += chunk;
      yield { type: "delta", content: chunk };
      await new Promise((r) => setTimeout(r, 25));
    }

    const inputTokens = approxTokens(req.messages.map((m) => m.content).join(" "));
    const outputTokens = approxTokens(text);
    const usdcCharged =
      (inputTokens / 1e6) * (price.inputPricePerM ?? 0) +
      (outputTokens / 1e6) * (price.outputPricePerM ?? 0);

    const result: CompletionResult = {
      provider: "mock",
      model,
      text,
      inputTokens,
      outputTokens,
      usdcCharged: Number(usdcCharged.toFixed(6)),
      paymentMode: "mock",
      latencyMs: Date.now() - start,
    };
    yield { type: "done", result };
  }

  return {
    id: "mock",
    displayName: "Mock Provider (offline)",
    models,
    priceFor,
    supports,
    stream,
  };
}
