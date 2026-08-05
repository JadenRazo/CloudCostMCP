/**
 * Vitest global setup — stubs fetch to prevent live network calls in unit tests.
 *
 * All pricing loaders gracefully fall back to bundled/static data when fetch
 * fails, so this gives deterministic results without network dependency.
 *
 * When RUN_INTEGRATION=1 the stub is NOT installed: the integration smoke
 * tests exist precisely to exercise the live provider APIs, and stubbing
 * fetch here silently forced them onto the static fallback path.
 *
 * Individual test files that need custom fetch behaviour can still override
 * with vi.stubGlobal("fetch", ...) in their own beforeEach/beforeAll.
 */

import { vi } from "vitest";

if (process.env.RUN_INTEGRATION !== "1") {
  vi.stubGlobal("fetch", async () => {
    throw new Error("fetch disabled in unit tests");
  });
}
