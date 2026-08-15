/**
 * Pricing-data freshness thresholds, declared once.
 *
 * The same fact used to live in three places with three different numbers:
 * `FRESH`/`AGING` in src/data/loader.ts, and a `MAX_AGE_DAYS = 21` inside a
 * shell heredoc in .github/workflows/ci.yml. Nothing tied them together, so
 * "stale" meant one thing to the MCP response and another to CI, and the CI
 * copy was invisible to the type checker, the linter, the test suite and the
 * coverage gate.
 *
 * Ordering matters and is asserted by a unit test: FRESH < GATE < AGING.
 * A gate stricter than `aging` would fail the build over data the product is
 * still willing to describe as merely aging; a gate looser than `aging` would
 * let the product report "stale" while CI stayed green.
 */

/** Below this, `pricing_metadata.staleness` is "fresh". */
export const FRESH_MAX_AGE_DAYS = 14;

/** At or above this, `pricing_metadata.staleness` is "stale". */
export const AGING_MAX_AGE_DAYS = 45;

/**
 * The age at which automation fails: the weekly freshness check and the
 * pre-publish gate. Sits between the two product buckets deliberately — the
 * weekly refresh should keep every provider under ~7 days, so crossing 21
 * means the refresh loop itself has stopped working.
 */
export const GATE_MAX_AGE_DAYS = 21;

export const MS_PER_DAY = 86_400_000;

/** Providers with bundled pricing data under data/<provider>-pricing/. */
export const PRICING_PROVIDERS = ["aws", "azure", "gcp"] as const;

export type PricingProvider = (typeof PRICING_PROVIDERS)[number];
