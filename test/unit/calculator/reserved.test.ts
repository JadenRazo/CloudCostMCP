import { describe, it, expect } from "vitest";
import { calculateReservedPricing } from "../../../src/calculator/reserved.js";
import type { ReservedComparison } from "../../../src/calculator/reserved.js";

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
      (o) => o.term === "1yr" && o.payment === "no_upfront"
    );
    expect(oneYrNoUpfront).toBeDefined();
    expect(oneYrNoUpfront!.percentage_savings).toBeCloseTo(36, 0);
    expect(oneYrNoUpfront!.monthly_cost).toBeCloseTo(64, 0);

    // AWS 3yr all_upfront = 60% discount
    const threeYrAllUpfront = result.options.find(
      (o) => o.term === "3yr" && o.payment === "all_upfront"
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
      0
    );
  });
});
