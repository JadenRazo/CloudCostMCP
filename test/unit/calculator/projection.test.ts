import { describe, it, expect } from "vitest";
import { calculateProjection } from "../../../src/calculator/projection.js";

describe("calculateProjection", () => {
  // ---------------------------------------------------------------------------
  // On-demand only (no reserved data)
  // ---------------------------------------------------------------------------

  it("returns on-demand projections with null reserved fields when no reserved input", () => {
    const result = calculateProjection(100, null);

    expect(result.projections).toHaveLength(4);

    for (const p of result.projections) {
      expect(p.on_demand_total).toBe(p.months * 100);
      expect(p.reserved_total).toBeNull();
      expect(p.savings).toBeNull();
      expect(p.savings_percentage).toBeNull();
    }

    expect(result.break_even_month).toBeNull();
    expect(result.recommended_commitment).toBeNull();
  });

  it("uses default horizons [3, 6, 12, 36]", () => {
    const result = calculateProjection(50, null);
    const months = result.projections.map((p) => p.months);
    expect(months).toEqual([3, 6, 12, 36]);
  });

  it("computes correct on-demand totals for default horizons", () => {
    const monthly = 200;
    const result = calculateProjection(monthly, null);

    expect(result.projections[0].on_demand_total).toBe(600); // 3 months
    expect(result.projections[1].on_demand_total).toBe(1200); // 6 months
    expect(result.projections[2].on_demand_total).toBe(2400); // 12 months
    expect(result.projections[3].on_demand_total).toBe(7200); // 36 months
  });

  // ---------------------------------------------------------------------------
  // Projection with reserved pricing
  // ---------------------------------------------------------------------------

  it("calculates reserved_total and savings when reserved input is provided", () => {
    // $100/month on-demand, $60/month reserved, no upfront
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 60, term: "1yr" },
    });

    const threeMonth = result.projections.find((p) => p.months === 3)!;
    expect(threeMonth.on_demand_total).toBe(300);
    expect(threeMonth.reserved_total).toBe(180); // 0 upfront + 60 * 3
    expect(threeMonth.savings).toBe(120);
    expect(threeMonth.savings_percentage).toBeCloseTo(40, 1);

    const twelveMonth = result.projections.find((p) => p.months === 12)!;
    expect(twelveMonth.on_demand_total).toBe(1200);
    expect(twelveMonth.reserved_total).toBe(720); // 60 * 12
    expect(twelveMonth.savings).toBe(480);
    expect(twelveMonth.savings_percentage).toBeCloseTo(40, 1);
  });

  it("includes upfront cost in reserved_total", () => {
    // $100/month on-demand, $50/month reserved, $200 upfront
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 50, term: "1yr", upfront: 200 },
    });

    const threeMonth = result.projections.find((p) => p.months === 3)!;
    expect(threeMonth.reserved_total).toBe(350); // 200 + 50 * 3
    expect(threeMonth.savings).toBe(-50); // 300 - 350 = -50 (on-demand cheaper at 3 months)

    const twelveMonth = result.projections.find((p) => p.months === 12)!;
    expect(twelveMonth.reserved_total).toBe(800); // 200 + 50 * 12
    expect(twelveMonth.savings).toBe(400); // 1200 - 800
  });

  // ---------------------------------------------------------------------------
  // Break-even calculation
  // ---------------------------------------------------------------------------

  it("finds the correct break-even month with no upfront cost", () => {
    // on-demand $100/month, reserved $70/month, no upfront
    // reserved is always cheaper so break-even is month 1
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 70, term: "1yr" },
    });

    expect(result.break_even_month).toBe(1);
  });

  it("finds the correct break-even month when upfront delays crossover", () => {
    // on-demand $100/month, reserved $60/month, $500 upfront
    // month 1: on-demand 100, reserved 560 → reserved more expensive
    // month m: 100m vs 500 + 60m → break-even when 100m > 500 + 60m → 40m > 500 → m > 12.5 → month 13
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 60, term: "1yr", upfront: 500 },
    });

    expect(result.break_even_month).toBe(13);
  });

  it("returns null break_even_month when reserved never beats on-demand within max horizon", () => {
    // on-demand $100/month, reserved $95/month, $5000 upfront
    // reserved cumulative always exceeds on-demand within 36 months
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 95, term: "3yr", upfront: 5000 },
    });

    expect(result.break_even_month).toBeNull();
  });

  it("returns null break_even_month when no reserved data provided", () => {
    const result = calculateProjection(100, null);
    expect(result.break_even_month).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Recommended commitment logic
  // ---------------------------------------------------------------------------

  it("recommends '1-year reserved' when break-even is before month 12", () => {
    // reserved always cheaper from month 1 (no upfront, lower monthly)
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 70, term: "1yr" },
    });

    expect(result.break_even_month).not.toBeNull();
    expect(result.break_even_month!).toBeLessThan(12);
    expect(result.recommended_commitment).toBe("1-year reserved");
  });

  it("recommends '3-year reserved' when break-even is between 12 and 35", () => {
    // on-demand $100/month, reserved $60/month, $1400 upfront
    // break-even: 100m > 1400 + 60m → 40m > 1400 → m > 35 → month 36 is just at boundary
    // Let's use upfront $1350 → break-even at 34: 40*34 = 1360 > 1350 ✓, 40*33 = 1320 < 1350 ✓
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 60, term: "3yr", upfront: 1300 },
    });

    // 40m > 1300 → m > 32.5 → break-even month 33
    expect(result.break_even_month).toBe(33);
    expect(result.recommended_commitment).toBe("3-year reserved");
  });

  it("returns null recommended_commitment when break-even is null", () => {
    const result = calculateProjection(100, null);
    expect(result.recommended_commitment).toBeNull();
  });

  it("returns null recommended_commitment when break-even is at or beyond month 36", () => {
    // on-demand $100/month, reserved $99/month, $2000 upfront
    // break-even: 1m > 2000 → m > 2000 → never within 36 months
    const result = calculateProjection(100, {
      best_reserved: { monthly_cost: 99, term: "3yr", upfront: 2000 },
    });

    expect(result.break_even_month).toBeNull();
    expect(result.recommended_commitment).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Custom horizons
  // ---------------------------------------------------------------------------

  it("respects custom horizons parameter", () => {
    const result = calculateProjection(100, null, [1, 24, 60]);

    const months = result.projections.map((p) => p.months);
    expect(months).toEqual([1, 24, 60]);

    expect(result.projections[0].on_demand_total).toBe(100);
    expect(result.projections[1].on_demand_total).toBe(2400);
    expect(result.projections[2].on_demand_total).toBe(6000);
  });

  it("sorts unsorted custom horizons ascending", () => {
    const result = calculateProjection(100, null, [36, 6, 12]);
    const months = result.projections.map((p) => p.months);
    expect(months).toEqual([6, 12, 36]);
  });

  it("uses custom max horizon as upper bound for break-even search", () => {
    // on-demand $100/month, reserved $60/month, $800 upfront
    // break-even: 40m > 800 → m > 20 → month 21
    // If we pass horizons [3, 6, 12] the max is 12, so break-even should not be found
    const result = calculateProjection(
      100,
      {
        best_reserved: { monthly_cost: 60, term: "1yr", upfront: 800 },
      },
      [3, 6, 12],
    );

    // Month 21 is beyond max horizon of 12, so break-even should be null
    expect(result.break_even_month).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Zero monthly cost
  // ---------------------------------------------------------------------------

  it("returns zero totals and null savings_percentage edge case for zero monthly cost", () => {
    const result = calculateProjection(0, null);

    for (const p of result.projections) {
      expect(p.on_demand_total).toBe(0);
      expect(p.reserved_total).toBeNull();
    }
  });

  it("returns zero reserved totals and zero savings when monthly is zero with reserved", () => {
    const result = calculateProjection(0, {
      best_reserved: { monthly_cost: 0, term: "1yr" },
    });

    for (const p of result.projections) {
      expect(p.on_demand_total).toBe(0);
      expect(p.reserved_total).toBe(0);
      expect(p.savings).toBe(0);
      expect(p.savings_percentage).toBe(0);
    }
  });
});
