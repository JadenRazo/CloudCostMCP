import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchWithRetry,
  fetchWithRetryAndCircuitBreaker,
  isCircuitOpen,
  recordCircuitSuccess,
  recordCircuitFailure,
  resetCircuit,
  resetAllCircuits,
} from "../../../src/pricing/fetch-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_URL = "https://example.com/api/pricing";

function makeOkResponse(body = "{}"): Response {
  return new Response(body, { status: 200 });
}

function makeErrorResponse(status: number): Response {
  return new Response("error", { status });
}

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

describe("fetchWithRetry", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAllCircuits();
  });

  it("returns immediately on first success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry(TEST_URL);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 error and eventually succeeds", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValue(makeOkResponse());

    vi.stubGlobal("fetch", mockFetch);

    // Sleep is no-op in test environment (VITEST=true), so no timer mocking needed
    const res = await fetchWithRetry(TEST_URL, undefined, {
      maxRetries: 3,
      baseDelay: 100,
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on network error", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValue(makeOkResponse());

    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry(TEST_URL, undefined, {
      maxRetries: 2,
      baseDelay: 100,
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after all retries exhausted", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("persistent failure"));
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      fetchWithRetry(TEST_URL, undefined, {
        maxRetries: 2,
        baseDelay: 100,
      }),
    ).rejects.toThrow("persistent failure");

    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("retries on 429 rate limit", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(429))
      .mockResolvedValue(makeOkResponse());

    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry(TEST_URL, undefined, {
      maxRetries: 2,
      baseDelay: 100,
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hardening: URL validation, response size cap, default timeout
// ---------------------------------------------------------------------------

describe("fetchWithRetry hardening", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAllCircuits();
  });

  it("rejects http:// URLs by default without calling fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetchWithRetry("http://example.com/")).rejects.toThrow(/non-https/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows http:// when requireHttps=false (test-only escape hatch)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry("http://localhost:3000/mock", undefined, {
      requireHttps: false,
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects hosts not in allowedHosts without calling fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      fetchWithRetry("https://evil.example.com/x", undefined, {
        allowedHosts: ["pricing.us-east-1.amazonaws.com"],
      }),
    ).rejects.toThrow(/not in allowlist/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("accepts hosts in allowedHosts", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry("https://pricing.us-east-1.amazonaws.com/a", undefined, {
      allowedHosts: ["pricing.us-east-1.amazonaws.com"],
    });
    expect(res.status).toBe(200);
  });

  it("rejects malformed URLs before calling fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetchWithRetry("not a url")).rejects.toThrow(/invalid URL/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("caps response body size — res.text() throws when body exceeds limit", async () => {
    // Produce a 2 MiB body; cap at 1 MiB.
    const big = "x".repeat(2 * 1024 * 1024);
    const mockFetch = vi.fn().mockResolvedValue(new Response(big, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry(TEST_URL, undefined, {
      maxResponseBytes: 1024 * 1024,
    });
    await expect(res.text()).rejects.toThrow(/exceeded 1048576 bytes/);
  });

  it("caps response body size — bodies under the limit read cleanly", async () => {
    const small = '{"hello":"world"}';
    const mockFetch = vi.fn().mockResolvedValue(new Response(small, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry(TEST_URL, undefined, {
      maxResponseBytes: 1024 * 1024,
    });
    await expect(res.json()).resolves.toEqual({ hello: "world" });
  });

  it("injects a default AbortSignal when caller does not provide one", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", mockFetch);

    await fetchWithRetry(TEST_URL);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves caller-supplied AbortSignal when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", mockFetch);

    const controller = new AbortController();
    await fetchWithRetry(TEST_URL, { signal: controller.signal });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("preserves response status and headers after body-cap wrapping", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 201,
        statusText: "Created",
        headers: { "x-custom": "42" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetry(TEST_URL);
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.headers.get("x-custom")).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  afterEach(() => {
    resetAllCircuits();
  });

  it("is closed initially", () => {
    expect(isCircuitOpen(TEST_URL)).toBe(false);
  });

  it("stays closed below threshold", () => {
    for (let i = 0; i < 4; i++) {
      recordCircuitFailure(TEST_URL);
    }
    expect(isCircuitOpen(TEST_URL)).toBe(false);
  });

  it("opens after threshold consecutive failures", () => {
    for (let i = 0; i < 5; i++) {
      recordCircuitFailure(TEST_URL);
    }
    expect(isCircuitOpen(TEST_URL)).toBe(true);
  });

  it("resets failure count on success", () => {
    for (let i = 0; i < 4; i++) {
      recordCircuitFailure(TEST_URL);
    }
    recordCircuitSuccess(TEST_URL);

    // After success, circuit should be closed even after another failure
    recordCircuitFailure(TEST_URL);
    expect(isCircuitOpen(TEST_URL)).toBe(false);
  });

  it("resetCircuit closes an open circuit immediately", () => {
    for (let i = 0; i < 5; i++) {
      recordCircuitFailure(TEST_URL);
    }
    expect(isCircuitOpen(TEST_URL)).toBe(true);

    resetCircuit(TEST_URL);
    expect(isCircuitOpen(TEST_URL)).toBe(false);
  });

  it("different URLs have independent circuit states", () => {
    const urlA = "https://api-a.example.com/pricing";
    const urlB = "https://api-b.example.com/pricing";

    for (let i = 0; i < 5; i++) {
      recordCircuitFailure(urlA);
    }

    expect(isCircuitOpen(urlA)).toBe(true);
    expect(isCircuitOpen(urlB)).toBe(false);

    resetAllCircuits();
  });
});

// ---------------------------------------------------------------------------
// fetchWithRetryAndCircuitBreaker
// ---------------------------------------------------------------------------

describe("fetchWithRetryAndCircuitBreaker", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAllCircuits();
  });

  it("throws immediately when circuit is open", async () => {
    // Open the circuit
    for (let i = 0; i < 5; i++) {
      recordCircuitFailure(TEST_URL);
    }

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetchWithRetryAndCircuitBreaker(TEST_URL)).rejects.toThrow(
      "Circuit breaker is open",
    );

    // fetch should never have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("succeeds and resets circuit on ok response", async () => {
    // Pre-load some failures (below threshold)
    recordCircuitFailure(TEST_URL);
    recordCircuitFailure(TEST_URL);

    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal("fetch", mockFetch);

    const res = await fetchWithRetryAndCircuitBreaker(TEST_URL);

    expect(res.status).toBe(200);
    expect(isCircuitOpen(TEST_URL)).toBe(false);
  });
});
