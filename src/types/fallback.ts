/**
 * Shared `FallbackMetadataSummary` type surfaced by the cost tools that can
 * return fallback-sourced prices (estimate_cost, compare_providers,
 * compare_actual, get_pricing).
 *
 * Downstream consumers inspect this object to decide whether the returned
 * prices are fresh enough to act on. `stale` flips true when any included
 * provider's bundled metadata is older than 30 days.
 */
import type { FallbackMetadata } from "../data/loader.js";
import { getFallbackMetadata } from "../data/loader.js";

export type FallbackProvider = "aws" | "azure" | "gcp";

export interface FallbackProviderEntry {
  last_updated: string;
  source?: string;
  sku_count?: number;
  refresh_script_version?: string;
}

export interface FallbackMetadataSummary {
  providers: Partial<Record<FallbackProvider, FallbackProviderEntry | null>>;
  stale: boolean;
  max_age_days: number;
}

const STALE_THRESHOLD_DAYS = 30;

function projectEntry(meta: FallbackMetadata | null): FallbackProviderEntry | null {
  if (!meta) return null;
  return {
    last_updated: meta.last_updated,
    source: meta.source,
    sku_count: meta.sku_count,
    refresh_script_version: meta.refresh_script_version,
  };
}

/**
 * Days elapsed between an ISO date string (YYYY-MM-DD, or any value Date
 * can parse) and now. Returns 0 when the date cannot be parsed — we prefer
 * "looks fresh" over synthesizing a huge age from a malformed input, and
 * the parsability failure is observable in `last_updated` itself.
 */
function daysSince(iso: string, now: Date = new Date()): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 0;
  const ms = now.getTime() - parsed;
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Build a fallback-metadata summary for the given provider set. Missing
 * provider metadata files resolve to `null` entries rather than being
 * omitted, so callers can distinguish "no metadata file yet" from
 * "provider wasn't requested".
 */
export function summarizeFallbackMetadata(
  providers: readonly FallbackProvider[],
  now: Date = new Date(),
): FallbackMetadataSummary {
  const summary: FallbackMetadataSummary = {
    providers: {},
    stale: false,
    max_age_days: 0,
  };

  for (const p of providers) {
    const entry = projectEntry(getFallbackMetadata(p));
    summary.providers[p] = entry;
    if (entry) {
      const age = daysSince(entry.last_updated, now);
      if (age > summary.max_age_days) summary.max_age_days = age;
      if (age > STALE_THRESHOLD_DAYS) summary.stale = true;
    }
  }

  return summary;
}
