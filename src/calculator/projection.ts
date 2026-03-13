import type { CostProjection } from "../types/pricing.js";

/**
 * Reserved pricing input accepted by calculateProjection. Matches the shape
 * returned by calculateReservedPricing so callers can pass best_option directly.
 */
export interface ProjectionReservedInput {
  best_reserved?: {
    monthly_cost: number;
    term: string;
    upfront?: number;
  };
}

const DEFAULT_HORIZONS = [3, 6, 12, 36];

/**
 * Builds a time-based cost projection showing cumulative on-demand vs reserved
 * spend across the supplied month horizons.
 *
 * Break-even is the first month (from month 1 up to max(horizons)) where the
 * cumulative reserved cost is strictly less than the cumulative on-demand cost.
 * When there is upfront cost the reserved option may be more expensive in early
 * months, so we walk month-by-month to find the exact crossover point.
 *
 * Recommended commitment:
 *   break_even_month < 12  → "1-year reserved"
 *   break_even_month < 36  → "3-year reserved"
 *   otherwise              → null
 */
export function calculateProjection(
  monthlyOnDemand: number,
  reservedComparison: ProjectionReservedInput | null,
  horizons: number[] = DEFAULT_HORIZONS
): CostProjection {
  const sortedHorizons = [...horizons].sort((a, b) => a - b);
  const maxHorizon = sortedHorizons[sortedHorizons.length - 1] ?? 0;

  const reserved = reservedComparison?.best_reserved ?? null;
  const reservedMonthly = reserved?.monthly_cost ?? null;
  const reservedUpfront = reserved?.upfront ?? 0;

  // Build projection rows for each horizon.
  const projections = sortedHorizons.map((months) => {
    const on_demand_total = Math.round(monthlyOnDemand * months * 100) / 100;

    if (reservedMonthly === null) {
      return {
        months,
        on_demand_total,
        reserved_total: null,
        savings: null,
        savings_percentage: null,
      };
    }

    const reserved_total =
      Math.round((reservedUpfront + reservedMonthly * months) * 100) / 100;
    const savings = Math.round((on_demand_total - reserved_total) * 100) / 100;
    const savings_percentage =
      on_demand_total === 0
        ? 0
        : Math.round((savings / on_demand_total) * 10000) / 100;

    return {
      months,
      on_demand_total,
      reserved_total,
      savings,
      savings_percentage,
    };
  });

  // Break-even calculation: walk month-by-month from 1 to maxHorizon.
  let break_even_month: number | null = null;

  if (reservedMonthly !== null && maxHorizon > 0) {
    for (let m = 1; m <= maxHorizon; m++) {
      const cumulativeOnDemand = monthlyOnDemand * m;
      const cumulativeReserved = reservedUpfront + reservedMonthly * m;
      if (cumulativeReserved < cumulativeOnDemand) {
        break_even_month = m;
        break;
      }
    }
  }

  // Recommended commitment based on break-even month.
  let recommended_commitment: string | null = null;
  if (break_even_month !== null) {
    if (break_even_month < 12) {
      recommended_commitment = "1-year reserved";
    } else if (break_even_month < 36) {
      recommended_commitment = "3-year reserved";
    }
  }

  return {
    projections,
    break_even_month,
    recommended_commitment,
  };
}
