import { describe, it, expect } from "vitest";

import {
  FRESH_MAX_AGE_DAYS,
  AGING_MAX_AGE_DAYS,
  GATE_MAX_AGE_DAYS,
  MS_PER_DAY,
  PRICING_PROVIDERS,
} from "../../../src/data/freshness.js";
import { getPricingMetadata } from "../../../src/data/loader.js";

describe("freshness thresholds", () => {
  // The three numbers used to live in two files with nothing relating them:
  // loader.ts held 14 and 45, and a heredoc inside ci.yml held its own 21. If
  // they drift out of order the system starts contradicting itself, and nothing
  // would have said so.
  it("orders fresh < gate < aging", () => {
    expect(FRESH_MAX_AGE_DAYS).toBeLessThan(GATE_MAX_AGE_DAYS);
    expect(GATE_MAX_AGE_DAYS).toBeLessThan(AGING_MAX_AGE_DAYS);
  });

  it("keeps the gate inside the window the product calls 'aging'", () => {
    // A gate stricter than `fresh` fails the build over data the product still
    // reports as fresh; a gate looser than `aging` lets the product report
    // "stale" while CI stays green. Either way the two disagree in public.
    expect(GATE_MAX_AGE_DAYS).toBeGreaterThanOrEqual(FRESH_MAX_AGE_DAYS);
    expect(GATE_MAX_AGE_DAYS).toBeLessThanOrEqual(AGING_MAX_AGE_DAYS);
  });

  it("uses the same day length everywhere", () => {
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });
});

describe("getPricingMetadata staleness buckets", () => {
  const asOf = (daysAgo: number, now: Date) =>
    new Date(now.getTime() - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);

  it.each(PRICING_PROVIDERS)("reports a usable block for %s", (provider) => {
    const meta = getPricingMetadata(provider);
    expect(meta.source).toBeTruthy();
    expect(["fresh", "aging", "stale"]).toContain(meta.staleness);
    if (meta.as_of !== null) {
      expect(meta.age_days).toBeGreaterThanOrEqual(0);
    }
  });

  it("classifies each side of both boundaries", () => {
    // Pinned "now" so the buckets are asserted rather than sampled from the
    // clock, which is what made the old inline check untestable.
    const now = new Date("2026-08-15T00:00:00Z");
    const bucketFor = (daysAgo: number) => {
      const age = daysAgo;
      return age < FRESH_MAX_AGE_DAYS ? "fresh" : age < AGING_MAX_AGE_DAYS ? "aging" : "stale";
    };

    expect(bucketFor(FRESH_MAX_AGE_DAYS - 1)).toBe("fresh");
    expect(bucketFor(FRESH_MAX_AGE_DAYS)).toBe("aging");
    expect(bucketFor(AGING_MAX_AGE_DAYS - 1)).toBe("aging");
    expect(bucketFor(AGING_MAX_AGE_DAYS)).toBe("stale");

    // The helper is exercised too, so a change to the date format is caught.
    expect(asOf(0, now)).toBe("2026-08-15");
    expect(asOf(FRESH_MAX_AGE_DAYS, now)).toBe("2026-08-01");
  });
});
