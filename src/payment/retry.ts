/**
 * Retry helper for x402 paid fetches under concurrency.
 *
 * BEAMR uses a single shared wallet, so firing several terminals at once means
 * several x402 settlements from the same payer hit the facilitator near-
 * simultaneously. Some get rejected with a pre-settlement verification error
 * (e.g. `invalid_exact_evm_transaction_simulation_failed`) — the payer is fine,
 * the facilitator just couldn't simulate/settle that one cleanly right then.
 *
 * SAFETY: we retry ONLY this class of error — an HTTP 402 whose body marks the
 * payment as *verification/simulation failed*. That state is provably BEFORE
 * settlement, so no USDC moved and re-signing (a fresh nonce each attempt) can
 * never double-charge. Generic 5xx are intentionally NOT retried: an upstream
 * error can occur *after* the facilitator already settled, and retrying that
 * would risk paying twice. Those fall through to normal provider failover.
 *
 * Backoff is exponential with jitter so colliding terminals stagger their
 * retries instead of re-colliding in lockstep.
 */

export interface X402RetryResult {
  /** A successful (2xx) response, body untouched and ready to stream. */
  response?: Response;
  /** Terminal failure: the last status + already-read body text. */
  status?: number;
  errorText?: string;
  ok: boolean;
}

export interface X402RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** Injectable sleep for tests (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in ms for deterministic tests (defaults to random 0–250). */
  jitterMs?: () => number;
  /**
   * Also retry transient upstream-overload errors (the inference backend being
   * overloaded / not ready). OFF by default and SAFE ONLY for providers where
   * such an error is proven not to settle payment — otherwise retrying risks
   * double-charging. Enabled for Hyperbolic, whose backend 503s are verified
   * not to debit the wallet (a 503 means no inference ran → no settlement).
   */
  retryUpstreamOverload?: boolean;
}

/**
 * True only for an x402 challenge that failed payment verification/simulation —
 * i.e. settlement did NOT happen, so a retry is safe. Matches the facilitator's
 * `x402_verification_failed` / `*_simulation_failed` reasons.
 */
export function isRetryablePaymentFailure(status: number, bodyText: string): boolean {
  if (status !== 402) return false;
  return /verification[_\s]?failed|simulation[_\s]?failed/i.test(bodyText);
}

/**
 * True for a transient upstream-overload signal: a gateway status (502/503/504)
 * or a wrapped backend error whose body says the model server is overloaded /
 * not ready / temporarily unavailable. Hyperbolic surfaces its upstream 503 as
 * an HTTP 500 with that text, so we inspect the body too.
 *
 * Only honored when the caller opts in (see `retryUpstreamOverload`).
 */
export function isRetryableUpstreamOverload(status: number, bodyText: string): boolean {
  if (status === 502 || status === 503 || status === 504) return true;
  return /\b50[234]\b|overloaded|not ready|temporarily unavailable/i.test(bodyText);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run an x402 paid request with safe retries on pre-settlement payment failures.
 *
 * `makeRequest` performs the full x402-fetch round-trip (it should sign a fresh
 * payment each call). On a retryable 402 we read the body, back off, and retry.
 * On success we return the response with its body unread (ready to stream). On a
 * terminal failure we return the status and the body text we already consumed.
 */
export async function fetchWithX402Retry(
  makeRequest: () => Promise<Response>,
  opts: X402RetryOpts = {},
): Promise<X402RetryResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 400;
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitterMs ?? (() => Math.floor(Math.random() * 250));

  let lastStatus = 0;
  let lastErr = "request failed before any response";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      return { ok: false, status: 0, errorText: "aborted" };
    }
    if (attempt > 0) {
      const delay = baseDelayMs * 2 ** (attempt - 1) + jitter();
      await sleep(delay);
    }

    let response: Response;
    try {
      response = await makeRequest();
    } catch (err) {
      // Network/abort error. Don't retry aborts; retry transient network errors.
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, status: 0, errorText: "aborted" };
      }
      lastErr = err instanceof Error ? err.message : String(err);
      lastStatus = 0;
      continue;
    }

    if (response.ok) return { ok: true, response };

    const errorText = await response.text().catch(() => "(no body)");
    lastStatus = response.status;
    lastErr = errorText;

    const retryable =
      isRetryablePaymentFailure(response.status, errorText) ||
      (opts.retryUpstreamOverload === true &&
        isRetryableUpstreamOverload(response.status, errorText));
    if (attempt < maxRetries && retryable) {
      continue;
    }
    return { ok: false, status: response.status, errorText };
  }

  return { ok: false, status: lastStatus, errorText: lastErr };
}
