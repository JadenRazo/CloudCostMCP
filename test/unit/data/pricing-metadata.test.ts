import { describe, it, expect } from "vitest";
import { getPricingMetadata, getFallbackMetadata } from "../../../src/data/loader.js";
import { EXCHANGE_RATES_AS_OF, getExchangeRateInfo } from "../../../src/currency.js";

describe("getPricingMetadata", () => {
  // The bundled data/<provider>-pricing/metadata.json files always exist in
  // the repo, so exercise the real loader end-to-end for each provider.
  it.each(["aws", "azure", "gcp"] as const)(
    "returns a complete block for %s bundled metadata",
    (provider) => {
      const block = getPricingMetadata(provider);
      expect(block.source).toBeTruthy();
      expect(block.as_of).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(block.age_days).toBeGreaterThanOrEqual(0);
      expect(["fresh", "aging", "stale"]).toContain(block.staleness);
    },
  );

  it("classifies staleness by age buckets (fresh <14d, aging <45d, stale >=45d)", () => {
    const meta = getFallbackMetadata("aws");
    expect(meta?.last_updated).toBeTruthy();
    const asOf = new Date(meta!.last_updated);

    const daysLater = (days: number) => new Date(asOf.getTime() + days * 86_400_000);

    expect(getPricingMetadata("aws", daysLater(0)).staleness).toBe("fresh");
    expect(getPricingMetadata("aws", daysLater(13)).staleness).toBe("fresh");
    expect(getPricingMetadata("aws", daysLater(14)).staleness).toBe("aging");
    expect(getPricingMetadata("aws", daysLater(44)).staleness).toBe("aging");
    expect(getPricingMetadata("aws", daysLater(45)).staleness).toBe("stale");
    expect(getPricingMetadata("aws", daysLater(400)).staleness).toBe("stale");
  });

  it("reports age_days computed from last_updated", () => {
    const meta = getFallbackMetadata("azure");
    const asOf = new Date(meta!.last_updated);
    const now = new Date(asOf.getTime() + 10 * 86_400_000 + 3600_000);
    const block = getPricingMetadata("azure", now);
    expect(block.age_days).toBe(10);
    expect(block.as_of).toBe(meta!.last_updated);
  });

  it("never reports a negative age for a future-dated file", () => {
    const meta = getFallbackMetadata("gcp");
    const asOf = new Date(meta!.last_updated);
    const before = new Date(asOf.getTime() - 5 * 86_400_000);
    expect(getPricingMetadata("gcp", before).age_days).toBe(0);
  });
});

describe("getExchangeRateInfo", () => {
  it("returns the static rate together with the table vintage", () => {
    const info = getExchangeRateInfo("EUR");
    expect(info.rate).toBe(0.92);
    expect(info.rate_as_of).toBe(EXCHANGE_RATES_AS_OF);
    expect(info.rate_as_of).toBe("2026-03");
  });

  it("reports identity rate for USD and unknown currencies", () => {
    expect(getExchangeRateInfo("USD").rate).toBe(1.0);
    expect(getExchangeRateInfo("XRP").rate).toBe(1.0);
  });
});
