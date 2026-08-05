import { getRegionPriceMultipliers } from "../data/loader.js";
import { logger } from "../logger.js";
import type { CloudProvider } from "../types/resources.js";

/**
 * Regional price multiplier lookup — reads from the shared
 * data/region-price-multipliers.json file so all providers use consistent
 * values sourced from one place. Unknown regions fall back to 1.0x (baseline
 * US-region pricing) with a warning.
 */
export function regionMultiplier(provider: CloudProvider, region: string): number {
  const mult = getRegionPriceMultipliers()[provider][region.toLowerCase()];
  if (mult === undefined) {
    logger.warn("region-multiplier: unknown region, defaulting to 1.0x", { provider, region });
    return 1.0;
  }
  return mult;
}
