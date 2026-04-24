import { describe, it, expect } from "vitest";
import { summarizeFallbackMetadata } from "../../../src/types/fallback.js";

// These tests rely on the bundled data/<provider>-pricing/metadata.json
// files being present. They intentionally reference `last_updated` via the
// live loader to keep behaviour close to production.

describe("summarizeFallbackMetadata", () => {
  it("returns a per-provider map keyed by the requested providers", () => {
    const summary = summarizeFallbackMetadata(["aws", "azure", "gcp"]);
    expect(Object.keys(summary.providers).sort()).toEqual(["aws", "azure", "gcp"]);
  });

  it("computes max_age_days against the supplied `now`", () => {
    // Fix "now" far in the future so all bundled metadata counts as stale.
    const future = new Date("2099-01-01T00:00:00Z");
    const summary = summarizeFallbackMetadata(["aws"], future);
    expect(summary.stale).toBe(true);
    expect(summary.max_age_days).toBeGreaterThan(30);
  });

  it("reports fresh when now is near the last_updated date", () => {
    const summary = summarizeFallbackMetadata(["aws"], new Date("2026-04-20T00:00:00Z"));
    // aws metadata.json is dated 2026-04-15, so 5 days old.
    expect(summary.stale).toBe(false);
    expect(summary.max_age_days).toBeLessThanOrEqual(30);
  });

  it("returns a subset map when only one provider is requested", () => {
    const summary = summarizeFallbackMetadata(["aws"]);
    expect(Object.keys(summary.providers)).toEqual(["aws"]);
  });

  it("preserves exactly the flat keys downstream consumers expect", () => {
    const summary = summarizeFallbackMetadata(["aws"]);
    const entry = summary.providers.aws;
    if (entry) {
      expect(Object.keys(entry).sort()).toEqual(
        ["last_updated", "refresh_script_version", "sku_count", "source"].sort(),
      );
    }
  });
});
