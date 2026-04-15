import type { AwsBulkPricingResponse, AwsOfferTerm } from "./types.js";
import type { PricingCache } from "../cache.js";
import { logger } from "../../logger.js";
import { fetchWithRetryAndCircuitBreaker } from "../fetch-utils.js";
import { BULK_PRICING_BASE, CACHE_TTL } from "./fallback-data.js";

// ---------------------------------------------------------------------------
// AWS Reserved / Savings-Plans client
// ---------------------------------------------------------------------------
//
// Reserved Instance pricing lives inside the same per-region bulk JSON blob
// already consumed by AwsBulkLoader at
//   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<Service>/current/<Region>/index.json
// under `terms.Reserved`. Each reserved offer carries a `termAttributes` object
// with `LeaseContractLength` ("1yr" | "3yr") and `PurchaseOption`
// ("No Upfront" | "Partial Upfront" | "All Upfront"), plus one or more price
// dimensions that quote either an upfront fee (unit `Quantity`) or an hourly
// rate (unit `Hrs`).
//
// To turn reserved terms into the discount-rate shape consumed by
// `calculator/reserved.ts`, we compute the **effective hourly price** (upfront
// amortised over term hours + hourly price) and divide by the on-demand hourly
// price for the same SKU. The result is `1 - effective/on_demand` — the
// fractional savings, which directly matches the static table shape.
// ---------------------------------------------------------------------------

const HOURS_IN_TERM: Record<"1yr" | "3yr", number> = {
  "1yr": 24 * 365,
  "3yr": 24 * 365 * 3,
};

export interface RiRate {
  term: "1yr" | "3yr";
  payment: "no_upfront" | "all_upfront" | "partial_upfront";
  rate: number; // fractional savings vs on-demand (0.0–1.0)
}

interface RiRateCacheEntry {
  price_per_unit: 0; // placeholder so autoRecordPricePoint ignores this row
  unit: "none";
  rates: RiRate[];
}

/**
 * Extract discount rates from a parsed AWS bulk-pricing response, given a
 * specific instance type / OS.
 *
 * Returns the full set of (term, payment, rate) tuples available for the SKU,
 * or an empty array if no reserved terms could be matched.
 */
export function extractRiRatesFromBulk(
  bulk: AwsBulkPricingResponse,
  instanceType: string,
  os: string = "Linux",
): RiRate[] {
  const products = bulk?.products ?? {};
  const onDemand = bulk?.terms?.OnDemand ?? {};
  const reserved = bulk?.terms?.Reserved ?? {};

  // Find the matching SKU (Shared tenancy, Used capacity, matching OS).
  let targetSku: string | null = null;
  for (const [sku, product] of Object.entries(products)) {
    const attrs = product?.attributes ?? {};
    if (
      attrs.instanceType === instanceType &&
      (attrs.operatingSystem ?? "").toLowerCase() === os.toLowerCase() &&
      attrs.tenancy === "Shared" &&
      attrs.capacitystatus === "Used"
    ) {
      targetSku = sku;
      break;
    }
  }

  if (!targetSku) return [];

  // Compute on-demand hourly baseline.
  const onDemandHourly = firstHourlyPrice(onDemand[targetSku]);
  if (!onDemandHourly || onDemandHourly <= 0) return [];

  const reservedOffers = reserved[targetSku];
  if (!reservedOffers) return [];

  const rates: RiRate[] = [];

  for (const offer of Object.values(reservedOffers)) {
    const lease = offer.termAttributes?.LeaseContractLength;
    const purchase = offer.termAttributes?.PurchaseOption;
    const term = normalizeTerm(lease);
    const payment = normalizePayment(purchase);
    if (!term || !payment) continue;

    const effectiveHourly = computeEffectiveHourly(offer, term);
    if (effectiveHourly === null) continue;

    const rate = 1 - effectiveHourly / onDemandHourly;
    // Discard garbage outside a plausible RI discount range.
    if (rate <= 0 || rate >= 0.9) continue;

    rates.push({ term, payment, rate });
  }

  return rates;
}

/**
 * Live fetch + in-memory extraction for a single instance type and region.
 *
 * For large services (notably EC2) the bulk JSON can exceed 1 GB and this call
 * will either time out or exhaust memory; callers must treat a `null` return
 * as "live data unavailable, use static fallback". Results are cached in the
 * shared SQLite cache under `aws/ri/<region>/<instanceType>/<os>`.
 */
export class AwsReservedClient {
  private cache: PricingCache;

  constructor(cache: PricingCache) {
    this.cache = cache;
  }

  async getRiRates(
    service: "AmazonEC2" | "AmazonRDS",
    instanceType: string,
    region: string,
    os: string = "Linux",
  ): Promise<RiRate[] | null> {
    const cacheKey = `aws/ri/${service.toLowerCase()}/${region.toLowerCase()}/${instanceType.toLowerCase()}/${os.toLowerCase()}`;

    const cached = this.cache.get<RiRateCacheEntry>(cacheKey);
    if (cached && Array.isArray(cached.rates)) return cached.rates;

    const url = `${BULK_PRICING_BASE}/${service}/current/${region}/index.json`;
    logger.debug("Fetching AWS bulk pricing for RI rates", { url });

    try {
      const res = await fetchWithRetryAndCircuitBreaker(
        url,
        { signal: AbortSignal.timeout(60_000) },
        { maxRetries: 0 },
      );
      if (!res.ok) {
        logger.debug("AWS RI bulk fetch non-OK", { status: res.status });
        return null;
      }

      const bulk = (await res.json()) as AwsBulkPricingResponse;
      const rates = extractRiRatesFromBulk(bulk, instanceType, os);
      if (rates.length === 0) return null;

      const entry: RiRateCacheEntry = {
        price_per_unit: 0,
        unit: "none",
        rates,
      };
      this.cache.set(cacheKey, entry, "aws", "ri", region, CACHE_TTL);
      return rates;
    } catch (err) {
      logger.debug("AWS RI bulk fetch failed, will use static fallback", {
        instanceType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function firstHourlyPrice(
  terms: Record<string, AwsOfferTerm> | undefined,
): number | null {
  if (!terms) return null;
  for (const term of Object.values(terms)) {
    for (const dim of Object.values(term.priceDimensions ?? {})) {
      if ((dim.unit ?? "").toLowerCase().startsWith("hr")) {
        const price = parseFloat(dim.pricePerUnit?.USD ?? "");
        if (isFinite(price) && price > 0) return price;
      }
    }
  }
  return null;
}

function computeEffectiveHourly(offer: AwsOfferTerm, term: "1yr" | "3yr"): number | null {
  let upfront = 0;
  let hourly = 0;
  let sawAnything = false;

  for (const dim of Object.values(offer.priceDimensions ?? {})) {
    const unit = (dim.unit ?? "").toLowerCase();
    const value = parseFloat(dim.pricePerUnit?.USD ?? "");
    if (!isFinite(value)) continue;

    if (unit.startsWith("hr")) {
      hourly = value;
      sawAnything = true;
    } else if (unit === "quantity") {
      upfront = value;
      sawAnything = true;
    }
  }

  if (!sawAnything) return null;
  return hourly + upfront / HOURS_IN_TERM[term];
}

function normalizeTerm(lease: string | undefined): "1yr" | "3yr" | null {
  if (lease === "1yr") return "1yr";
  if (lease === "3yr") return "3yr";
  return null;
}

function normalizePayment(
  purchase: string | undefined,
): "no_upfront" | "all_upfront" | "partial_upfront" | null {
  switch (purchase) {
    case "No Upfront":
      return "no_upfront";
    case "All Upfront":
      return "all_upfront";
    case "Partial Upfront":
      return "partial_upfront";
    default:
      return null;
  }
}
