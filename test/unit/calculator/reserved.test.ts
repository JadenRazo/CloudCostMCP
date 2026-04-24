import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateReservedPricing,
  calculateAwsReservedPricingLive,
  setLiveGcpCudRates,
  clearLiveGcpCudRates,
  getLiveGcpCudRates,
  calculateGcpReservedPricingLive,
  calculateAzureReservedPricingLive,
} from "../../../src/calculator/reserved.js";

describe("calculateReservedPricing", () => {
  it("returns all AWS reserved options", () => {
    const result = calculateReservedPricing(100, "aws");

    expect(result.on_demand_monthly).toBe(100);
    expect(result.options.length).toBe(6);
    // AWS has 6 options: 1yr/3yr x no/partial/all upfront
    expect(result.options.every((o) => o.monthly_cost < 100)).toBe(true);
    expect(result.options.every((o) => o.monthly_savings > 0)).toBe(true);
  });

  it("returns all Azure reserved options", () => {
    const result = calculateReservedPricing(100, "azure");

    expect(result.on_demand_monthly).toBe(100);
    expect(result.options.length).toBe(4);
    // Azure has 4 options: 1yr/3yr x all/partial upfront
  });

  it("returns all GCP committed use options", () => {
    const result = calculateReservedPricing(100, "gcp");

    expect(result.on_demand_monthly).toBe(100);
    expect(result.options.length).toBe(4);
  });

  it("best_option has the highest savings", () => {
    const result = calculateReservedPricing(200, "aws");

    const maxSavings = Math.max(...result.options.map((o) => o.monthly_savings));
    expect(result.best_option.monthly_savings).toBe(maxSavings);
  });

  it("savings percentages match the discount rates", () => {
    const result = calculateReservedPricing(100, "aws");

    // AWS 1yr no_upfront = 36% discount
    const oneYrNoUpfront = result.options.find(
      (o) => o.term === "1yr" && o.payment === "no_upfront",
    );
    expect(oneYrNoUpfront).toBeDefined();
    expect(oneYrNoUpfront!.percentage_savings).toBeCloseTo(36, 0);
    expect(oneYrNoUpfront!.monthly_cost).toBeCloseTo(64, 0);

    // AWS 3yr all_upfront = 60% discount
    const threeYrAllUpfront = result.options.find(
      (o) => o.term === "3yr" && o.payment === "all_upfront",
    );
    expect(threeYrAllUpfront).toBeDefined();
    expect(threeYrAllUpfront!.percentage_savings).toBeCloseTo(60, 0);
    expect(threeYrAllUpfront!.monthly_cost).toBeCloseTo(40, 0);
  });

  it("rounds costs to two decimal places", () => {
    const result = calculateReservedPricing(33.33, "aws");

    for (const option of result.options) {
      const decimals = option.monthly_cost.toString().split(".")[1] ?? "";
      expect(decimals.length).toBeLessThanOrEqual(2);
    }
  });

  it("handles zero on-demand cost", () => {
    const result = calculateReservedPricing(0, "aws");

    expect(result.on_demand_monthly).toBe(0);
    expect(result.options.every((o) => o.monthly_cost === 0)).toBe(true);
    expect(result.options.every((o) => o.monthly_savings === 0)).toBe(true);
  });

  it("scales linearly with on-demand cost", () => {
    const small = calculateReservedPricing(100, "gcp");
    const large = calculateReservedPricing(1000, "gcp");

    // Best option savings should scale 10x
    expect(large.best_option.monthly_savings).toBeCloseTo(
      small.best_option.monthly_savings * 10,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// GCP CUD cache helpers
// ---------------------------------------------------------------------------

describe("GCP CUD cache helpers", () => {
  beforeEach(() => {
    clearLiveGcpCudRates();
  });

  it("getLiveGcpCudRates returns undefined when cache is empty", () => {
    expect(getLiveGcpCudRates("us-central1")).toBeUndefined();
  });

  it("set/get round-trips rates for a region", () => {
    const rates = { term1yr: 0.28, term3yr: 0.55 };
    setLiveGcpCudRates("us-central1", rates);

    expect(getLiveGcpCudRates("us-central1")).toEqual(rates);
  });

  it("normalises region key to lowercase", () => {
    const rates = { term1yr: 0.3, term3yr: 0.5 };
    setLiveGcpCudRates("US-CENTRAL1", rates);

    expect(getLiveGcpCudRates("us-central1")).toEqual(rates);
    expect(getLiveGcpCudRates("US-Central1")).toEqual(rates);
  });

  it("clearLiveGcpCudRates removes all cached regions", () => {
    setLiveGcpCudRates("us-central1", { term1yr: 0.28, term3yr: 0.55 });
    setLiveGcpCudRates("europe-west1", { term1yr: 0.25, term3yr: 0.5 });

    clearLiveGcpCudRates();

    expect(getLiveGcpCudRates("us-central1")).toBeUndefined();
    expect(getLiveGcpCudRates("europe-west1")).toBeUndefined();
  });

  it("handles null term rates", () => {
    const rates = { term1yr: null, term3yr: 0.55 };
    setLiveGcpCudRates("us-east1", rates);

    expect(getLiveGcpCudRates("us-east1")).toEqual(rates);
  });

  it("overwrites existing entry for the same region", () => {
    setLiveGcpCudRates("us-central1", { term1yr: 0.1, term3yr: 0.2 });
    setLiveGcpCudRates("us-central1", { term1yr: 0.3, term3yr: 0.6 });

    expect(getLiveGcpCudRates("us-central1")).toEqual({ term1yr: 0.3, term3yr: 0.6 });
  });
});

// ---------------------------------------------------------------------------
// calculateAwsReservedPricingLive
// ---------------------------------------------------------------------------

describe("calculateAwsReservedPricingLive", () => {
  it("returns live source when client returns valid rates", async () => {
    const client = {
      getReservedRates: vi.fn().mockResolvedValue([
        { term: "1yr" as const, rate: 0.4 },
        { term: "3yr" as const, rate: 0.65 },
      ]),
    };

    const result = await calculateAwsReservedPricingLive(100, "m5.large", "us-east-1", client);

    expect(result.source).toBe("live");
    expect(result.on_demand_monthly).toBe(100);
    expect(result.options.length).toBe(6);
    expect(client.getReservedRates).toHaveBeenCalledWith("m5.large", "us-east-1", "Linux");
  });

  it("passes custom os parameter to client", async () => {
    const client = {
      getReservedRates: vi.fn().mockResolvedValue([{ term: "1yr" as const, rate: 0.35 }]),
    };

    await calculateAwsReservedPricingLive(100, "m5.large", "us-east-1", client, "Windows");

    expect(client.getReservedRates).toHaveBeenCalledWith("m5.large", "us-east-1", "Windows");
  });

  it("applies overrides from live rates to the options", async () => {
    const liveRate1yr = 0.5;
    const client = {
      getReservedRates: vi.fn().mockResolvedValue([{ term: "1yr" as const, rate: liveRate1yr }]),
    };

    const result = await calculateAwsReservedPricingLive(200, "m5.large", "us-east-1", client);

    // All 1yr options should reflect the live 50% rate override
    const oneYrOptions = result.options.filter((o) => o.term === "1yr");
    for (const opt of oneYrOptions) {
      expect(opt.percentage_savings).toBeCloseTo(50, 0);
      expect(opt.monthly_cost).toBeCloseTo(100, 0);
    }
  });

  it("picks the best rate per term when multiple rates returned", async () => {
    const client = {
      getReservedRates: vi.fn().mockResolvedValue([
        { term: "1yr" as const, rate: 0.3 },
        { term: "1yr" as const, rate: 0.45 },
        { term: "3yr" as const, rate: 0.5 },
        { term: "3yr" as const, rate: 0.7 },
      ]),
    };

    const result = await calculateAwsReservedPricingLive(100, "m5.large", "us-east-1", client);

    expect(result.source).toBe("live");
    // Best 1yr rate is 0.45 -> 45% savings
    const oneYrOpt = result.options.find((o) => o.term === "1yr");
    expect(oneYrOpt!.percentage_savings).toBeCloseTo(45, 0);
    // Best 3yr rate is 0.7 -> 70% savings
    const threeYrOpt = result.options.find((o) => o.term === "3yr");
    expect(threeYrOpt!.percentage_savings).toBeCloseTo(70, 0);
  });

  it("falls back when client throws", async () => {
    const client = {
      getReservedRates: vi.fn().mockRejectedValue(new Error("API timeout")),
    };

    const result = await calculateAwsReservedPricingLive(100, "m5.large", "us-east-1", client);

    expect(result.source).toBe("fallback");
    expect(result.options.length).toBe(6);
  });

  it("falls back when client returns null", async () => {
    const client = {
      getReservedRates: vi.fn().mockResolvedValue(null),
    };

    const result = await calculateAwsReservedPricingLive(100, "m5.large", "us-east-1", client);

    expect(result.source).toBe("fallback");
  });

  it("falls back when client returns empty array", async () => {
    const client = {
      getReservedRates: vi.fn().mockResolvedValue([]),
    };

    const result = await calculateAwsReservedPricingLive(100, "m5.large", "us-east-1", client);

    expect(result.source).toBe("fallback");
  });

  it("falls back when client has no getReservedRates method", async () => {
    const client = {};

    const result = await calculateAwsReservedPricingLive(100, "m5.large", "us-east-1", client);

    expect(result.source).toBe("fallback");
    expect(result.options.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// calculateGcpReservedPricingLive
// ---------------------------------------------------------------------------

describe("calculateGcpReservedPricingLive", () => {
  beforeEach(() => {
    clearLiveGcpCudRates();
  });

  it("returns live source when client returns valid CUD rates", async () => {
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue({
        term1yr: 0.3,
        term3yr: 0.56,
        sample_count: 12,
      }),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(result.source).toBe("live");
    expect(result.on_demand_monthly).toBe(100);
    expect(result.options.length).toBe(4);
    expect(client.fetchCudRates).toHaveBeenCalledWith("us-central1");
  });

  it("applies live rates as overrides to GCP options", async () => {
    const liveRate1yr = 0.35;
    const liveRate3yr = 0.6;
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue({
        term1yr: liveRate1yr,
        term3yr: liveRate3yr,
        sample_count: 5,
      }),
    };

    const result = await calculateGcpReservedPricingLive(200, "us-central1", client);

    const oneYrOpt = result.options.find((o) => o.term === "1yr");
    expect(oneYrOpt!.percentage_savings).toBeCloseTo(35, 0);
    const threeYrOpt = result.options.find((o) => o.term === "3yr");
    expect(threeYrOpt!.percentage_savings).toBeCloseTo(60, 0);
  });

  it("caches fetched rates via setLiveGcpCudRates", async () => {
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue({
        term1yr: 0.3,
        term3yr: 0.55,
        sample_count: 10,
      }),
    };

    await calculateGcpReservedPricingLive(100, "us-central1", client);

    const cached = getLiveGcpCudRates("us-central1");
    expect(cached).toEqual({ term1yr: 0.3, term3yr: 0.55 });
  });

  it("handles partial live data (only 1yr rate)", async () => {
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue({
        term1yr: 0.32,
        term3yr: null,
        sample_count: 3,
      }),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(result.source).toBe("live");
    // 1yr options should reflect the live rate
    const oneYrOpt = result.options.find((o) => o.term === "1yr");
    expect(oneYrOpt!.percentage_savings).toBeCloseTo(32, 0);
  });

  it("handles partial live data (only 3yr rate)", async () => {
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue({
        term1yr: null,
        term3yr: 0.58,
        sample_count: 2,
      }),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(result.source).toBe("live");
    const threeYrOpt = result.options.find((o) => o.term === "3yr");
    expect(threeYrOpt!.percentage_savings).toBeCloseTo(58, 0);
  });

  it("falls back when client throws", async () => {
    const client = {
      fetchCudRates: vi.fn().mockRejectedValue(new Error("network error")),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(result.source).toBe("fallback");
    expect(result.options.length).toBe(4);
  });

  it("falls back when client returns null", async () => {
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue(null),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(result.source).toBe("fallback");
  });

  it("does not cache when client returns null", async () => {
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue(null),
    };

    await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(getLiveGcpCudRates("us-central1")).toBeUndefined();
  });

  it("falls back when both term rates are null", async () => {
    const client = {
      fetchCudRates: vi.fn().mockResolvedValue({
        term1yr: null,
        term3yr: null,
        sample_count: 0,
      }),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    // source stays fallback because no overrides were set
    expect(result.source).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// calculateAzureReservedPricingLive
// ---------------------------------------------------------------------------

describe("calculateAzureReservedPricingLive", () => {
  const onDemandMonthly = 150;
  const onDemandHourly = 0.2055; // ~$150/month at 730 hrs

  it("returns live source when client returns valid hourly rates", async () => {
    const client = {
      getReservationHourlyRate: vi
        .fn()
        .mockImplementation((_vm: string, _region: string, term: "1yr" | "3yr") => {
          if (term === "1yr") return Promise.resolve(0.13);
          return Promise.resolve(0.08);
        }),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      onDemandHourly,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("live");
    expect(result.on_demand_monthly).toBe(onDemandMonthly);
    expect(result.options.length).toBe(4);
    expect(client.getReservationHourlyRate).toHaveBeenCalledWith(
      "Standard_D4s_v3",
      "eastus",
      "1yr",
    );
    expect(client.getReservationHourlyRate).toHaveBeenCalledWith(
      "Standard_D4s_v3",
      "eastus",
      "3yr",
    );
  });

  it("computes correct discount from hourly rates", async () => {
    const hourlyOnDemand = 1.0;
    const monthlyOnDemand = 730; // 730 hrs * $1
    const reservedHourly1yr = 0.6; // 40% discount
    const reservedHourly3yr = 0.3; // 70% discount

    const client = {
      getReservationHourlyRate: vi
        .fn()
        .mockImplementation((_vm: string, _region: string, term: "1yr" | "3yr") => {
          if (term === "1yr") return Promise.resolve(reservedHourly1yr);
          return Promise.resolve(reservedHourly3yr);
        }),
    };

    const result = await calculateAzureReservedPricingLive(
      monthlyOnDemand,
      hourlyOnDemand,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("live");
    // 1yr options should reflect 40% discount
    const oneYrOpt = result.options.find((o) => o.term === "1yr");
    expect(oneYrOpt!.percentage_savings).toBeCloseTo(40, 0);
    // 3yr options should reflect 70% discount
    const threeYrOpt = result.options.find((o) => o.term === "3yr");
    expect(threeYrOpt!.percentage_savings).toBeCloseTo(70, 0);
  });

  it("falls back when client throws", async () => {
    const client = {
      getReservationHourlyRate: vi.fn().mockRejectedValue(new Error("API error")),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      onDemandHourly,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("fallback");
    expect(result.options.length).toBe(4);
  });

  it("falls back when onDemandHourly is zero", async () => {
    const client = {
      getReservationHourlyRate: vi.fn().mockResolvedValue(0.1),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      0,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("fallback");
    // Client should never be called when hourly is zero
    expect(client.getReservationHourlyRate).not.toHaveBeenCalled();
  });

  it("falls back when onDemandHourly is NaN", async () => {
    const client = {
      getReservationHourlyRate: vi.fn().mockResolvedValue(0.1),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      NaN,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("fallback");
    expect(client.getReservationHourlyRate).not.toHaveBeenCalled();
  });

  it("falls back when onDemandHourly is negative", async () => {
    const client = {
      getReservationHourlyRate: vi.fn().mockResolvedValue(0.1),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      -1,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("fallback");
    expect(client.getReservationHourlyRate).not.toHaveBeenCalled();
  });

  it("ignores reservation rate that exceeds on-demand rate", async () => {
    const client = {
      getReservationHourlyRate: vi
        .fn()
        .mockImplementation((_vm: string, _region: string, term: "1yr" | "3yr") => {
          // 1yr rate higher than on-demand — should be ignored
          if (term === "1yr") return Promise.resolve(0.5);
          return Promise.resolve(0.05);
        }),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      onDemandHourly,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("live");
    // 3yr was valid so source is live, but 1yr should use static fallback rate
    // Azure static 1yr all_upfront = 35%
    const oneYrAllUpfront = result.options.find(
      (o) => o.term === "1yr" && o.payment === "all_upfront",
    );
    // The 1yr options should NOT reflect the bogus 0.5 rate.
    // With no 1yr override, the static 35% rate applies.
    expect(oneYrAllUpfront!.percentage_savings).toBeCloseTo(35, 0);
  });

  it("ignores reservation rate of zero", async () => {
    const client = {
      getReservationHourlyRate: vi
        .fn()
        .mockImplementation((_vm: string, _region: string, term: "1yr" | "3yr") => {
          if (term === "1yr") return Promise.resolve(0);
          return Promise.resolve(0.08);
        }),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      onDemandHourly,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("live");
    // Zero reservation rate filtered out — 1yr stays at static rate
  });

  it("falls back when client returns null for both terms", async () => {
    const client = {
      getReservationHourlyRate: vi.fn().mockResolvedValue(null),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      onDemandHourly,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("fallback");
  });

  it("handles partial data — only 1yr rate available", async () => {
    const client = {
      getReservationHourlyRate: vi
        .fn()
        .mockImplementation((_vm: string, _region: string, term: "1yr" | "3yr") => {
          if (term === "1yr") return Promise.resolve(0.13);
          return Promise.resolve(null);
        }),
    };

    const result = await calculateAzureReservedPricingLive(
      onDemandMonthly,
      onDemandHourly,
      "Standard_D4s_v3",
      "eastus",
      client,
    );

    expect(result.source).toBe("live");
  });
});
