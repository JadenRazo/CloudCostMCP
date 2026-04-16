import type { PricingCache } from "../cache.js";
import { logger } from "../../logger.js";
import { fetchWithRetryAndCircuitBreaker } from "../fetch-utils.js";
import { CACHE_TTL } from "./fallback-data.js";

// ---------------------------------------------------------------------------
// AWS Spot Advisor client
// ---------------------------------------------------------------------------
//
// AWS publishes spot interruption/savings data at a public, unauthenticated
// endpoint consumed by the Spot Advisor web tool. The JSON document contains
// per-region, per-instance "s" (savings percent) values representing the
// typical discount compared to on-demand pricing.
//
// Schema (abbreviated):
//   {
//     "spot_advisor": {
//       "<region>": {
//         "Linux":   { "<instanceType>": { "s": 65, "r": 2 }, ... },
//         "Windows": { ... }
//       }
//     }
//   }
//
// `s` is a percent integer (0–100); 65 means 65% savings, i.e. you pay 35% of
// the on-demand rate.
//
// The endpoint below is the one backing https://aws.amazon.com/ec2/spot/instance-advisor/.
// ---------------------------------------------------------------------------

const SPOT_ADVISOR_URL = "https://website.spot.ec2.aws.a2z.com/spot.json";
const SPOT_ADVISOR_CACHE_KEY = "aws/spot-advisor/v1";

type OsKey = "Linux" | "Windows";

interface SpotAdvisorInstance {
  s: number; // savings percent (0-100)
  r?: number; // interruption rate bucket
}

interface SpotAdvisorRegion {
  Linux?: Record<string, SpotAdvisorInstance>;
  Windows?: Record<string, SpotAdvisorInstance>;
}

interface SpotAdvisorDoc {
  spot_advisor: Record<string, SpotAdvisorRegion>;
}

/**
 * Per-instance spot discount lookup keyed by region + OS + instance type.
 * Returns the **factor of on-demand you pay** (e.g. 0.35 = pay 35%, save 65%),
 * or null when no data is available.
 */
export class AwsSpotClient {
  private cache: PricingCache;

  /** In-flight fetch deduplication. */
  private inflight: Promise<SpotAdvisorDoc | null> | null = null;

  constructor(cache: PricingCache) {
    this.cache = cache;
  }

  /**
   * Get the spot discount factor (0–1) for an instance type in a region.
   *
   * Returns a fraction representing the **portion of on-demand you pay** — i.e.
   * `hourly_spot = hourly_on_demand * factor`. Returns null when the live data
   * is unavailable or doesn't cover the given instance/region combination;
   * callers should fall back to static family-based estimates in that case.
   */
  async getSpotFactor(
    instanceType: string,
    region: string,
    os: "Linux" | "Windows" = "Linux",
  ): Promise<number | null> {
    try {
      const doc = await this.loadDocument();
      if (!doc) return null;

      const regionData = doc.spot_advisor?.[region];
      if (!regionData) return null;

      const osKey: OsKey = os === "Windows" ? "Windows" : "Linux";
      const osData = regionData[osKey];
      if (!osData) return null;

      const entry = osData[instanceType];
      if (!entry || typeof entry.s !== "number") return null;

      // Clamp into sane bounds. AWS Spot Advisor reports 0-90% savings; values
      // outside that range are almost certainly garbage and shouldn't be used.
      const savingsPct = Math.max(0, Math.min(95, entry.s));
      const factor = 1 - savingsPct / 100;

      // Floor the factor at 0.05 so we never report a "free" instance even if
      // the upstream data is corrupt.
      return Math.max(0.05, factor);
    } catch (err) {
      logger.debug("AwsSpotClient.getSpotFactor failed", {
        instanceType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fetch and cache the full Spot Advisor document. Uses the shared SQLite
   * cache with the same TTL as other AWS bulk data. Deduplicates concurrent
   * callers via an in-flight promise.
   */
  private loadDocument(): Promise<SpotAdvisorDoc | null> {
    const cached = this.cache.get<SpotAdvisorDoc>(SPOT_ADVISOR_CACHE_KEY);
    if (cached) return Promise.resolve(cached);

    if (this.inflight) return this.inflight;

    this.inflight = this.doFetchDocument().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doFetchDocument(): Promise<SpotAdvisorDoc | null> {
    logger.debug("Fetching AWS Spot Advisor JSON", { url: SPOT_ADVISOR_URL });

    try {
      const res = await fetchWithRetryAndCircuitBreaker(
        SPOT_ADVISOR_URL,
        { signal: AbortSignal.timeout(20_000) },
        { maxRetries: 1, baseDelay: 500, maxDelay: 2_000 },
      );

      if (!res.ok) {
        logger.debug("AWS Spot Advisor fetch returned non-OK", { status: res.status });
        return null;
      }

      const doc = (await res.json()) as SpotAdvisorDoc;

      if (!doc || typeof doc.spot_advisor !== "object") {
        logger.debug("AWS Spot Advisor response missing spot_advisor key");
        return null;
      }

      // Cache the full document so subsequent instance lookups are free. The
      // spot-advisor blob is ~2 MB uncompressed — small enough to keep in the
      // single-row cache table.
      this.cache.set(SPOT_ADVISOR_CACHE_KEY, doc, "aws", "spot-advisor", "global", CACHE_TTL);

      return doc;
    } catch (err) {
      logger.debug("AWS Spot Advisor fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
