/**
 * Vitest global setup — stubs fetch to prevent live network calls in unit tests.
 *
 * All pricing loaders gracefully fall back to bundled/static data when fetch
 * fails, so this gives deterministic results without network dependency.
 *
 * Individual test files that need custom fetch behaviour (e.g. pricing live
 * tests) can override the stub with vi.stubGlobal("fetch", ...) in their
 * own beforeEach/beforeAll.
 */

import { vi } from "vitest";

vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});
