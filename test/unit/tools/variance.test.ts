import { describe, it, expect } from "vitest";
import { computeVariance } from "../../../src/tools/variance.js";
import type { FocusRow } from "../../../src/reporting/focus-parser.js";
import { FocusCurrencyMismatchError } from "../../../src/reporting/focus-parser.js";

function focus(overrides: Partial<FocusRow>): FocusRow {
  return {
    resourceId: "i-a",
    actualMonthly: 10,
    service: "Amazon EC2",
    region: "us-east-1",
    currency: "USD",
    period: { start: "2026-04-01", end: "2026-05-01" },
    ...overrides,
  };
}

describe("computeVariance — totals", () => {
  it("computes positive variance when actual exceeds estimate", () => {
    const result = computeVariance(
      [{ resource_id: "i-a", monthly_cost: 10 }],
      [focus({ resourceId: "i-a", actualMonthly: 15 })],
      { currency: "USD" },
    );
    expect(result.total_estimated).toBe(10);
    expect(result.total_actual).toBe(15);
    expect(result.total_variance).toBe(5);
    expect(result.pct).toBe(50);
  });

  it("computes negative variance when actual is below estimate", () => {
    const result = computeVariance(
      [{ resource_id: "i-a", monthly_cost: 20 }],
      [focus({ resourceId: "i-a", actualMonthly: 5 })],
      { currency: "USD" },
    );
    expect(result.total_variance).toBe(-15);
    expect(result.pct).toBe(-75);
  });

  it("returns zero variance for matched zero-cost resources", () => {
    const result = computeVariance(
      [{ resource_id: "i-a", monthly_cost: 0 }],
      [focus({ resourceId: "i-a", actualMonthly: 0 })],
      { currency: "USD" },
    );
    expect(result.total_variance).toBe(0);
    expect(result.pct).toBe(0);
  });

  it("guards division by zero when estimate is 0 but actual is non-zero", () => {
    const result = computeVariance(
      [{ resource_id: "i-a", monthly_cost: 0 }],
      [focus({ resourceId: "i-a", actualMonthly: 5 })],
      { currency: "USD" },
    );
    expect(result.pct).toBe(100);
    expect(Number.isFinite(result.pct)).toBe(true);
  });
});

describe("computeVariance — coverage sets", () => {
  it("reports missing_actuals and extra_actuals", () => {
    const result = computeVariance(
      [
        { resource_id: "i-a", monthly_cost: 10 },
        { resource_id: "i-missing", monthly_cost: 20 },
      ],
      [
        focus({ resourceId: "i-a", actualMonthly: 12 }),
        focus({ resourceId: "i-extra", actualMonthly: 7 }),
      ],
      { currency: "USD" },
    );
    expect(result.missing_actuals).toEqual(["i-missing"]);
    expect(result.extra_actuals).toEqual(["i-extra"]);
  });

  it("sorts missing_actuals and extra_actuals lexicographically", () => {
    const result = computeVariance(
      [
        { resource_id: "b", monthly_cost: 1 },
        { resource_id: "a", monthly_cost: 1 },
      ],
      [focus({ resourceId: "z", actualMonthly: 1 }), focus({ resourceId: "y", actualMonthly: 1 })],
      { currency: "USD" },
    );
    expect(result.missing_actuals).toEqual(["a", "b"]);
    expect(result.extra_actuals).toEqual(["y", "z"]);
  });
});

describe("computeVariance — top_drivers", () => {
  it("orders by abs(delta) desc with lexicographic tie-break", () => {
    const result = computeVariance(
      [
        { resource_id: "i-a", monthly_cost: 10 },
        { resource_id: "i-b", monthly_cost: 10 },
        { resource_id: "i-c", monthly_cost: 10 },
      ],
      [
        focus({ resourceId: "i-a", actualMonthly: 30 }), // delta +20
        focus({ resourceId: "i-b", actualMonthly: 0 }), // delta -10
        focus({ resourceId: "i-c", actualMonthly: 30 }), // delta +20 (tie with a)
      ],
      { currency: "USD" },
    );
    expect(result.top_drivers.map((d) => d.resource_id)).toEqual(["i-a", "i-c", "i-b"]);
  });

  it("caps to maxDrivers", () => {
    const estimates = Array.from({ length: 10 }, (_, i) => ({
      resource_id: `i-${i}`,
      monthly_cost: 10,
    }));
    const actuals = estimates.map((e, i) =>
      focus({ resourceId: e.resource_id, actualMonthly: 10 + i }),
    );
    const result = computeVariance(estimates, actuals, { currency: "USD", maxDrivers: 3 });
    expect(result.top_drivers).toHaveLength(3);
    expect(result.top_drivers[0]!.resource_id).toBe("i-9");
  });

  it("defaults to top 5 drivers", () => {
    const estimates = Array.from({ length: 7 }, (_, i) => ({
      resource_id: `i-${i}`,
      monthly_cost: 10,
    }));
    const actuals = estimates.map((e, i) =>
      focus({ resourceId: e.resource_id, actualMonthly: 10 + i }),
    );
    const result = computeVariance(estimates, actuals, { currency: "USD" });
    expect(result.top_drivers).toHaveLength(5);
  });
});

describe("computeVariance — currency + fail-closed", () => {
  it("throws FocusCurrencyMismatchError when row currency differs from expected", () => {
    expect(() =>
      computeVariance(
        [{ resource_id: "i-a", monthly_cost: 10 }],
        [focus({ resourceId: "i-a", currency: "EUR" })],
        { currency: "USD" },
      ),
    ).toThrow(FocusCurrencyMismatchError);
  });

  it("skips non-finite estimate entries with a warning", () => {
    const result = computeVariance(
      [
        { resource_id: "i-a", monthly_cost: Number.NaN },
        { resource_id: "i-b", monthly_cost: 5 },
      ],
      [focus({ resourceId: "i-b", actualMonthly: 7 })],
      { currency: "USD" },
    );
    expect(result.warnings.some((w) => /non-finite estimate/.test(w))).toBe(true);
    expect(result.total_estimated).toBe(5);
  });

  it("skips non-finite actual entries with a warning", () => {
    const result = computeVariance(
      [{ resource_id: "i-a", monthly_cost: 10 }],
      [focus({ resourceId: "i-a", actualMonthly: Number.POSITIVE_INFINITY })],
      { currency: "USD" },
    );
    expect(result.warnings.some((w) => /non-finite actual/.test(w))).toBe(true);
    // When actual was dropped, i-a becomes a "missing actual" from the
    // estimate perspective.
    expect(result.missing_actuals).toContain("i-a");
  });

  it("returns safe zeros for empty inputs", () => {
    const result = computeVariance([], [], { currency: "USD" });
    expect(result.total_estimated).toBe(0);
    expect(result.total_actual).toBe(0);
    expect(result.total_variance).toBe(0);
    expect(result.pct).toBe(0);
    expect(result.top_drivers).toEqual([]);
  });
});
