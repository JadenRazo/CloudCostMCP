/**
 * Helpers for stubbing global `fetch` with realistic `Response` objects.
 *
 * Production code in this project exercises `res.body.pipeThrough(...)` for
 * streaming CSV fetches and `res.json()` for bulk-JSON fetches. A plain
 * `{ ok, status, json }` object works for the latter but breaks the former,
 * so these helpers wrap payloads in a real `Response` backed by a
 * `ReadableStream` — matching the real fetch contract.
 */

/**
 * Build a Response whose body is a single chunk of text, streamable via
 * `res.body.pipeThrough(new TextDecoderStream())`. Use for CSV streaming
 * tests that need `res.body` to be a real ReadableStream.
 */
export function makeStreamingTextResponse(
  text: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "text/csv" },
  });
}

/**
 * Build a Response whose body is streamed as multiple chunks, to exercise
 * the "partial line carried across chunk boundaries" code path.
 */
export function makeMultiChunkResponse(chunks: string[], init: { status?: number } = {}): Response {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= encoded.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoded[i]!);
      i++;
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { "content-type": "text/csv" },
  });
}

/**
 * Build a Response with a JSON body. Callers reading `.body` get a real
 * stream, and `.json()` / `.text()` behave as expected.
 */
export function makeJsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "application/json" },
  });
}

/**
 * Build an empty-body, non-OK Response.
 */
export function makeErrorResponse(status: number): Response {
  return new Response(null, { status });
}
