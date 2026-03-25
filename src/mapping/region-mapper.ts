import type { CloudProvider } from "../types/resources.js";
import type { RegionMapping } from "../types/mapping.js";
import { getRegionMappings } from "../data/loader.js";
import { logger } from "../logger.js";

// Default regions to fall back to when a mapping does not exist.
const DEFAULT_REGIONS: Record<CloudProvider, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
};

/**
 * Maps a region identifier from one cloud provider to the geographically
 * closest equivalent on a target provider.
 *
 * Falls back to the canonical default region for the target provider when the
 * source region is not present in the mapping table. The fallback is logged at
 * debug level so callers can diagnose unexpected mappings in tests.
 */
export function mapRegion(
  region: string,
  sourceProvider: CloudProvider,
  targetProvider: CloudProvider
): string {
  if (sourceProvider === targetProvider) return region;

  const mappings = getRegionMappings();

  const row = mappings.find(
    (entry: RegionMapping) => entry[sourceProvider] === region
  );

  if (!row) {
    const fallback = DEFAULT_REGIONS[targetProvider];
    logger.debug("region-mapper: no mapping found, using default", {
      region,
      sourceProvider,
      targetProvider,
      fallback,
    });
    return fallback;
  }

  const mapped = row[targetProvider];
  if (!mapped) {
    return DEFAULT_REGIONS[targetProvider];
  }

  return mapped;
}
