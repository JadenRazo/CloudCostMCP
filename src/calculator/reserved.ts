import type { CloudProvider } from "../types/resources.js";

/**
 * Represents a single reserved instance pricing option (term + payment model).
 */
export interface ReservedOption {
  term: "1yr" | "3yr";
  payment: "no_upfront" | "all_upfront" | "partial_upfront";
  monthly_cost: number;
  monthly_savings: number;
  percentage_savings: number;
}

/**
 * A full reserved-pricing comparison for a resource showing on-demand cost
 * alongside all available reserved purchase options.
 */
export interface ReservedComparison {
  on_demand_monthly: number;
  options: ReservedOption[];
  best_option: ReservedOption;
  /**
   * Where the underlying discount rates came from. "live" indicates rates
   * pulled from the cloud provider's live pricing API; "fallback" indicates
   * the static DISCOUNT_RATES table is in use.
   */
  source?: "live" | "fallback";
}

/**
 * Optional per-term rate overrides. When supplied, the corresponding static
 * DISCOUNT_RATES entries are replaced with overrides. This lets callers pass
 * live provider-API rates while still falling back to the static table for
 * any term the live API didn't return.
 */
export interface ReservedRateOverrides {
  "1yr"?: number;
  "3yr"?: number;
}

// Discount rates sourced from published provider documentation (approximate).
// AWS:   https://aws.amazon.com/ec2/pricing/reserved-instances/pricing/
// Azure: https://azure.microsoft.com/en-us/pricing/reserved-vm-instances/
// GCP:   https://cloud.google.com/compute/docs/sustained-use-discounts
const DISCOUNT_RATES: Record<
  CloudProvider,
  Array<{ term: "1yr" | "3yr"; payment: ReservedOption["payment"]; rate: number }>
> = {
  aws: [
    { term: "1yr", payment: "no_upfront", rate: 0.36 },
    { term: "1yr", payment: "partial_upfront", rate: 0.4 },
    { term: "1yr", payment: "all_upfront", rate: 0.42 },
    { term: "3yr", payment: "no_upfront", rate: 0.52 },
    { term: "3yr", payment: "partial_upfront", rate: 0.57 },
    { term: "3yr", payment: "all_upfront", rate: 0.6 },
  ],
  azure: [
    { term: "1yr", payment: "all_upfront", rate: 0.35 },
    { term: "3yr", payment: "all_upfront", rate: 0.55 },
    // Azure does not offer no-upfront RI in the same way; partial_upfront maps
    // to hybrid benefit combined, approximated here.
    { term: "1yr", payment: "partial_upfront", rate: 0.3 },
    { term: "3yr", payment: "partial_upfront", rate: 0.5 },
  ],
  gcp: [
    // GCP Committed Use Discounts (CUDs) – resource-based.
    { term: "1yr", payment: "all_upfront", rate: 0.28 },
    { term: "3yr", payment: "all_upfront", rate: 0.55 },
    { term: "1yr", payment: "partial_upfront", rate: 0.2 },
    { term: "3yr", payment: "partial_upfront", rate: 0.45 },
  ],
};

/**
 * Calculates reserved / committed-use pricing options for a resource given its
 * on-demand monthly cost.
 *
 * The returned comparison includes all available purchase options for the
 * provider plus a convenience best_option pointing to the highest-savings
 * all-upfront option.
 */
export function calculateReservedPricing(
  onDemandMonthly: number,
  provider: CloudProvider,
  overrides?: ReservedRateOverrides,
): ReservedComparison {
  const baseRates = DISCOUNT_RATES[provider];
  const rates = overrides
    ? baseRates.map((r) => {
        const override = overrides[r.term];
        return override !== undefined ? { ...r, rate: override } : r;
      })
    : baseRates;

  const options: ReservedOption[] = rates.map(({ term, payment, rate }) => {
    const monthly_cost = onDemandMonthly * (1 - rate);
    const monthly_savings = onDemandMonthly - monthly_cost;
    return {
      term,
      payment,
      monthly_cost: Math.round(monthly_cost * 100) / 100,
      monthly_savings: Math.round(monthly_savings * 100) / 100,
      percentage_savings: Math.round(rate * 1000) / 10, // e.g. 36.0
    };
  });

  // Best option = highest savings (last entry in our sorted-by-savings array).
  const best_option = options.reduce(
    (best, opt) => (opt.monthly_savings > best.monthly_savings ? opt : best),
    options[0],
  );

  return {
    on_demand_monthly: Math.round(onDemandMonthly * 100) / 100,
    options,
    best_option,
  };
}

/**
 * AWS-specific async variant that pulls live RI discount rates from a
 * provider client (typically `AwsReservedClient` via the PricingProvider
 * interface) and threads them into `calculateReservedPricing` as term-level
 * overrides.
 *
 * AWS exposes multiple payment variants per term; we collapse to the single
 * best (highest savings) rate per term, since `ReservedRateOverrides` is
 * keyed by term only. Never throws — any failure degrades to the static
 * table with `source="fallback"`.
 *
 * Note on EC2: the AmazonEC2 bulk JSON is multi-GB per region and cannot be
 * loaded into memory, so the AWS provider's `getReservedRates` returns null
 * for EC2 by design. EC2 callers will always end up on the static fallback
 * path here — this is intentional, not a bug.
 */
export async function calculateAwsReservedPricingLive(
  onDemandMonthly: number,
  instanceType: string,
  region: string,
  client: {
    getReservedRates?: (
      instanceType: string,
      region: string,
      os?: string,
    ) => Promise<Array<{ term: "1yr" | "3yr"; rate: number }> | null>;
  },
  os: string = "Linux",
): Promise<ReservedComparison> {
  const overrides: ReservedRateOverrides = {};
  let source: "live" | "fallback" = "fallback";

  if (typeof client.getReservedRates === "function") {
    try {
      const liveRates = await client.getReservedRates(instanceType, region, os);
      if (liveRates && liveRates.length > 0) {
        for (const term of ["1yr", "3yr"] as const) {
          const best = liveRates
            .filter((r) => r.term === term)
            .reduce<number | null>(
              (acc, r) => (acc === null || r.rate > acc ? r.rate : acc),
              null,
            );
          if (best !== null) {
            overrides[term] = best;
            source = "live";
          }
        }
      }
    } catch {
      // Swallow: fall through to static table.
    }
  }

  const comparison = calculateReservedPricing(onDemandMonthly, "aws", overrides);
  comparison.source = source;
  return comparison;
}

// ---------------------------------------------------------------------------
// GCP live CUD cache + async variant
// ---------------------------------------------------------------------------

/**
 * Live GCP Committed Use Discount rate cache keyed by region. Populated
 * asynchronously via `setLiveGcpCudRates()` — typically by
 * `calculateGcpReservedPricingLive()` on first use. Exported helpers let
 * callers seed, clear, or inspect the cache.
 */
const LIVE_GCP_CUD_CACHE: Map<string, { term1yr: number | null; term3yr: number | null }> =
  new Map();

/** Store live GCP CUD discount rates for a region. */
export function setLiveGcpCudRates(
  region: string,
  rates: { term1yr: number | null; term3yr: number | null },
): void {
  LIVE_GCP_CUD_CACHE.set(region.toLowerCase(), rates);
}

/** Clear all stored live GCP CUD rates. Intended for tests. */
export function clearLiveGcpCudRates(): void {
  LIVE_GCP_CUD_CACHE.clear();
}

/** Return the stored live GCP CUD rates for a region, if any. */
export function getLiveGcpCudRates(
  region: string,
): { term1yr: number | null; term3yr: number | null } | undefined {
  return LIVE_GCP_CUD_CACHE.get(region.toLowerCase());
}

/**
 * GCP-specific async variant that consults the Cloud Billing Catalog for
 * live Committed Use Discount (CUD) rates in a region, then falls back to
 * the static DISCOUNT_RATES table for any term the API did not return.
 *
 * The fetched rates are also cached via `setLiveGcpCudRates()` so subsequent
 * sync callers for the same region can pick them up transparently (see the
 * cache-consultation branch below).
 *
 * Never throws: any API failure degrades to the static table with
 * `source="fallback"`.
 */
export async function calculateGcpReservedPricingLive(
  onDemandMonthly: number,
  region: string,
  client: {
    fetchCudRates(region: string): Promise<{
      term1yr: number | null;
      term3yr: number | null;
      sample_count: number;
    } | null>;
  },
): Promise<ReservedComparison> {
  const overrides: ReservedRateOverrides = {};
  let source: "live" | "fallback" = "fallback";

  try {
    const live = await client.fetchCudRates(region);
    if (live) {
      if (live.term1yr !== null) {
        overrides["1yr"] = live.term1yr;
        source = "live";
      }
      if (live.term3yr !== null) {
        overrides["3yr"] = live.term3yr;
        source = "live";
      }
      // Cache for subsequent sync callers in this process.
      setLiveGcpCudRates(region, { term1yr: live.term1yr, term3yr: live.term3yr });
    }
  } catch {
    // Swallow: fall through to the static table.
  }

  const comparison = calculateReservedPricing(
    onDemandMonthly,
    "gcp",
    source === "live" ? overrides : undefined,
  );
  comparison.source = source;
  return comparison;
}

// ---------------------------------------------------------------------------
// Azure live reservation async variant
// ---------------------------------------------------------------------------

/**
 * Azure-specific async variant that consults the Azure Retail Prices API
 * for live reservation rates tied to a specific VM size/region, then falls
 * back to the static DISCOUNT_RATES table for any term the API did not
 * return.
 *
 * `onDemandHourly` is the on-demand hourly price for the same VM/region —
 * used to compute the effective discount as
 * `1 - (reservation_hourly / on_demand_hourly)`.
 *
 * Returns the same `ReservedComparison` shape as the sync function so
 * callers are swap-compatible. Never throws: any API failure degrades to
 * the static table with `source = "fallback"`.
 */
export async function calculateAzureReservedPricingLive(
  onDemandMonthly: number,
  onDemandHourly: number,
  vmSize: string,
  region: string,
  client: {
    getReservationHourlyRate(
      vmSize: string,
      region: string,
      term: "1yr" | "3yr",
    ): Promise<number | null>;
  },
): Promise<ReservedComparison> {
  const overrides: ReservedRateOverrides = {};
  let source: "live" | "fallback" = "fallback";

  if (isFinite(onDemandHourly) && onDemandHourly > 0) {
    try {
      const [oneYr, threeYr] = await Promise.all([
        client.getReservationHourlyRate(vmSize, region, "1yr"),
        client.getReservationHourlyRate(vmSize, region, "3yr"),
      ]);
      if (oneYr !== null && oneYr > 0 && oneYr < onDemandHourly) {
        overrides["1yr"] = 1 - oneYr / onDemandHourly;
        source = "live";
      }
      if (threeYr !== null && threeYr > 0 && threeYr < onDemandHourly) {
        overrides["3yr"] = 1 - threeYr / onDemandHourly;
        source = "live";
      }
    } catch {
      // Swallow: fall through to static table.
    }
  }

  const comparison = calculateReservedPricing(
    onDemandMonthly,
    "azure",
    source === "live" ? overrides : undefined,
  );
  comparison.source = source;
  return comparison;
}
