import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// fetchWithRetry — exponential backoff retry wrapper with hardening
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  /**
   * When set, restrict the URL host to this allowlist. Requests to any other
   * host are rejected synchronously before any network call is made. Used as
   * defense-in-depth against URL-injection / SSRF when any path segment of
   * the URL is user-influenced.
   */
  allowedHosts?: readonly string[];
  /**
   * Maximum response body size in bytes. The body is wrapped in a
   * TransformStream that errors once the cap is exceeded, so `res.json()`,
   * `res.text()`, and `res.body.pipeThrough(...)` all enforce the ceiling.
   * Protects against OOM from compromised / misbehaving upstreams.
   * Default: 100 MiB. Pass a larger value (or `Infinity`) for known-large
   * streaming responses such as AWS bulk pricing CSVs.
   */
  maxResponseBytes?: number;
  /**
   * When true (default) the URL must use the `https:` scheme. Reject
   * everything else to prevent plaintext exfiltration and local-loopback
   * SSRF via `http://127.0.0.1`.
   */
  requireHttps?: boolean;
  /**
   * Default per-request timeout applied when the caller did not pass an
   * AbortSignal in `init`. Prevents hangs when a caller forgets to set a
   * timeout. Default: 60 000 ms.
   */
  defaultTimeoutMs?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Validate the URL scheme and host before any network call.
 * Throws a synchronous error (no retry) on rejection.
 */
function assertUrlAllowed(url: string, options: RetryOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`fetchWithRetry: invalid URL`);
  }

  const requireHttps = options.requireHttps ?? true;
  if (requireHttps && parsed.protocol !== "https:") {
    throw new Error(`fetchWithRetry: rejected non-https URL (scheme=${parsed.protocol})`);
  }

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    if (!options.allowedHosts.includes(parsed.host)) {
      throw new Error(`fetchWithRetry: host ${parsed.host} not in allowlist`);
    }
  }

  return parsed;
}

/**
 * Wrap a Response so that reading its body aborts once `maxBytes` is
 * exceeded. Preserves status, statusText, and headers.
 */
function capResponseBody(res: Response, maxBytes: number): Response {
  if (!res.body) return res;
  if (!Number.isFinite(maxBytes)) return res;

  let seen = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new Error(`fetchWithRetry: response body exceeded ${maxBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  const limited = res.body.pipeThrough(limiter);
  return new Response(limited, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * Inject a default AbortSignal timeout when the caller did not provide one.
 * If the caller already passed a signal, leave it untouched — callers that
 * want shorter timeouts stay in control.
 */
function withDefaultSignal(init: RequestInit | undefined, timeoutMs: number): RequestInit {
  if (init?.signal) return init;
  return { ...(init ?? {}), signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Wraps fetch() with exponential backoff retry logic plus safety hardening:
 *   - URL scheme/host validation (rejects http, optional host allowlist)
 *   - Response body size cap (prevents OOM on adversarial upstreams)
 *   - Default request timeout (prevents hangs when caller forgets a signal)
 *
 * Retries on network errors and HTTP 429/5xx responses.
 * Each retry waits baseDelay * 2^attempt ms, capped at maxDelay.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  assertUrlAllowed(url, options);
  const safeInit = withDefaultSignal(init, defaultTimeoutMs);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, safeInit);

      // Retry on rate-limit or server errors
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < maxRetries) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
          logger.warn("fetchWithRetry: retryable HTTP status, backing off", {
            url,
            status: res.status,
            attempt,
            delayMs: delay,
          });
          await sleep(delay);
          continue;
        }
      }

      return capResponseBody(res, maxResponseBytes);
    } catch (err) {
      lastError = err;

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        logger.warn("fetchWithRetry: network error, backing off", {
          url,
          attempt,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay);
      } else {
        logger.error("fetchWithRetry: all retries exhausted", {
          url,
          maxRetries,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  throw lastError ?? new Error(`fetchWithRetry: all ${maxRetries} retries failed for ${url}`);
}

function sleep(ms: number): Promise<void> {
  // In test environments, skip the actual delay so tests run at full speed.
  // The retry logic (call count, error propagation) is still exercised.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CircuitBreaker — prevents repeated calls to a failing endpoint
// ---------------------------------------------------------------------------

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number; // epoch ms; 0 = closed
}

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const circuitStates = new Map<string, CircuitState>();

/**
 * Returns the circuit key for a URL (scheme + host).
 */
function circuitKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/**
 * Returns true when the circuit breaker is open (endpoint should be skipped).
 */
export function isCircuitOpen(url: string): boolean {
  const key = circuitKey(url);
  const state = circuitStates.get(key);
  if (!state) return false;

  if (state.openUntil > 0 && Date.now() < state.openUntil) {
    return true;
  }

  // Circuit has elapsed — reset to half-open (allow one probe)
  if (state.openUntil > 0 && Date.now() >= state.openUntil) {
    state.openUntil = 0;
    state.consecutiveFailures = 0;
  }

  return false;
}

/**
 * Record a successful call to an endpoint, resetting its failure counter.
 */
export function recordCircuitSuccess(url: string): void {
  const key = circuitKey(url);
  const state = circuitStates.get(key);
  if (state) {
    state.consecutiveFailures = 0;
    state.openUntil = 0;
  }
}

/**
 * Record a failed call to an endpoint. Opens the circuit after
 * CIRCUIT_FAILURE_THRESHOLD consecutive failures.
 */
export function recordCircuitFailure(url: string): void {
  const key = circuitKey(url);
  let state = circuitStates.get(key);
  if (!state) {
    state = { consecutiveFailures: 0, openUntil: 0 };
    circuitStates.set(key, state);
  }

  state.consecutiveFailures++;

  if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
    logger.warn("Circuit breaker opened", {
      endpoint: key,
      consecutiveFailures: state.consecutiveFailures,
      openForMinutes: CIRCUIT_OPEN_DURATION_MS / 60_000,
    });
  }
}

/**
 * fetchWithRetry wrapped with circuit breaker protection.
 *
 * If the circuit is open for this endpoint, throws immediately without
 * making a network request. On success, resets the circuit. On failure,
 * records the failure toward the threshold.
 */
export async function fetchWithRetryAndCircuitBreaker(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  if (isCircuitOpen(url)) {
    const key = circuitKey(url);
    throw new Error(
      `Circuit breaker is open for ${key} — skipping request to avoid repeated failures`,
    );
  }

  try {
    const res = await fetchWithRetry(url, init, options);
    // Only record success for 2xx responses
    if (res.ok) {
      recordCircuitSuccess(url);
    } else {
      recordCircuitFailure(url);
    }
    return res;
  } catch (err) {
    recordCircuitFailure(url);
    throw err;
  }
}

/**
 * Reset circuit breaker state for a given URL (primarily for testing).
 */
export function resetCircuit(url: string): void {
  circuitStates.delete(circuitKey(url));
}

/**
 * Reset all circuit breaker state (primarily for testing).
 */
export function resetAllCircuits(): void {
  circuitStates.clear();
}
