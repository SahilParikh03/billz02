import { describe, it, expect, vi } from "vitest";
import {
  fetchWithX402Retry,
  isRetryablePaymentFailure,
  isRetryableUpstreamOverload,
} from "./retry";

const VERIFY_FAIL_BODY = JSON.stringify({
  error: {
    message: "Payment verification failed: invalid_exact_evm_transaction_simulation_failed",
    code: "x402_verification_failed",
  },
});

// Deterministic test opts: no real timers, zero jitter.
const fastOpts = { baseDelayMs: 1, sleep: async () => {}, jitterMs: () => 0 };

function resp(status: number, body = "", ok?: boolean): Response {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("isRetryablePaymentFailure", () => {
  it("true only for 402 with a verification/simulation failure", () => {
    expect(isRetryablePaymentFailure(402, VERIFY_FAIL_BODY)).toBe(true);
    expect(isRetryablePaymentFailure(402, "simulation_failed")).toBe(true);
    expect(isRetryablePaymentFailure(402, "verification failed")).toBe(true);
  });

  it("false for 402 challenges that are not verification failures", () => {
    expect(isRetryablePaymentFailure(402, JSON.stringify({ error: "X-PAYMENT required" }))).toBe(false);
  });

  it("false for 5xx (may be post-settlement — must not retry/double-charge)", () => {
    expect(isRetryablePaymentFailure(500, "simulation_failed")).toBe(false);
    expect(isRetryablePaymentFailure(503, "overloaded")).toBe(false);
  });
});

describe("isRetryableUpstreamOverload", () => {
  it("true for gateway statuses and overloaded/not-ready bodies", () => {
    expect(isRetryableUpstreamOverload(503, "")).toBe(true);
    expect(isRetryableUpstreamOverload(502, "")).toBe(true);
    expect(isRetryableUpstreamOverload(500, "Backend Error: 503 - overloaded or not ready")).toBe(true);
    expect(isRetryableUpstreamOverload(500, "temporarily unavailable")).toBe(true);
  });

  it("false for ordinary errors (e.g. 400 non-serverless model)", () => {
    expect(isRetryableUpstreamOverload(400, "Unable to access non-serverless model")).toBe(false);
    expect(isRetryableUpstreamOverload(200, "ok")).toBe(false);
  });
});

describe("fetchWithX402Retry", () => {
  it("returns immediately on success (body untouched)", async () => {
    const fn = vi.fn(async () => resp(200, "ok-body"));
    const r = await fetchWithX402Retry(fn, fastOpts);
    expect(r.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await r.response!.text()).toBe("ok-body");
  });

  it("retries a verification-failure 402 then succeeds", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(resp(402, VERIFY_FAIL_BODY))
      .mockResolvedValueOnce(resp(402, VERIFY_FAIL_BODY))
      .mockResolvedValueOnce(resp(200, "finally"));
    const r = await fetchWithX402Retry(fn, fastOpts);
    expect(r.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries and returns the last error", async () => {
    const fn = vi.fn(async () => resp(402, VERIFY_FAIL_BODY));
    const r = await fetchWithX402Retry(fn, { ...fastOpts, maxRetries: 2 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(402);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does NOT retry a 5xx by default (avoids double-charge) — fails after one attempt", async () => {
    const fn = vi.fn(async () => resp(500, "Backend Error: 503 overloaded"));
    const r = await fetchWithX402Retry(fn, fastOpts);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries upstream overload only when opted in (Hyperbolic, verified uncharged)", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(resp(500, "Backend Error: 503 - The server is overloaded or not ready yet."))
      .mockResolvedValueOnce(resp(200, "recovered"));
    const r = await fetchWithX402Retry(fn, { ...fastOpts, retryUpstreamOverload: true });
    expect(r.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => resp(200, "x"));
    const r = await fetchWithX402Retry(fn, { ...fastOpts, signal: controller.signal });
    expect(r.ok).toBe(false);
    expect(r.errorText).toBe("aborted");
    expect(fn).not.toHaveBeenCalled();
  });
});
