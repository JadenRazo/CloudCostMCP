/**
 * GCP pricing source smoke test.
 *
 * Gated behind RUN_INTEGRATION=1.
 *
 * This file replaces a test that could not fail. The old version probed the
 * Cloud Billing Catalog API through `CloudBillingClient.fetchComputeSkus`,
 * which catches every error and returns `null`; the test then read `null` as
 * "upstream catalog miss" and called `ctx.skip()`. A hard `403 PERMISSION_DENIED`
 * — the response that endpoint gives every unregistered caller, forever — was
 * therefore reported as a green skip. That is why the daily health check scored
 * "live provider APIs: ok" for four months while GCP was entirely dead, and it
 * is the single reason the outage stayed invisible.
 *
 * The rules this file follows, so that cannot recur:
 *   1. A non-2xx from the source FAILS. It is never skipped and never soft-passed.
 *   2. The URL under test is imported, not retyped, so it cannot drift from the
 *      one scripts/refresh-pricing.ts actually fetches.
 *   3. The shape the refresh depends on is asserted field by field. A 200 that
 *      returns a restructured document is a failure, not a pass.
 *   4. The bundled numbers are compared against the live source, so a refresh
 *      that ran but mapped the wrong field is caught.
 *
 * Run locally:
 *   RUN_INTEGRATION=1 npx vitest run test/integration/gcp-pricing.smoke.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse as parseYaml } from "yaml";

import { GCP_PRICING_SOURCE_URL } from "../../src/data/pricing-sources.js";
import { getGcpComputePricing, getGcpStoragePricing } from "../../src/data/loader.js";
import { GATE_MAX_AGE_DAYS, MS_PER_DAY } from "../../src/data/freshness.js";

const RUN = process.env.RUN_INTEGRATION === "1";

interface GcostsEntry {
  cost?: Record<string, { hour?: number; month?: number }>;
}
interface GcostsDoc {
  about?: { generated?: string; timestamp?: number };
  compute?: { instance?: Record<string, GcostsEntry>; storage?: Record<string, GcostsEntry> };
  storage?: { bucket?: Record<string, GcostsEntry> };
}

describe.skipIf(!RUN)("GCP pricing source smoke", () => {
  let status = 0;
  let doc: GcostsDoc;

  beforeAll(async () => {
    const res = await fetch(GCP_PRICING_SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
    status = res.status;
    // Read the body only on success; a 404 page is not YAML and the status
    // assertion below is what should report the failure.
    if (res.ok) doc = parseYaml(await res.text()) as GcostsDoc;
  }, 120_000);

  it("the upstream the refresh depends on responds 2xx", () => {
    // Deliberately an assertion and not a skip. The previous incarnation of
    // this file turned exactly this condition into a green run.
    expect(status, `${GCP_PRICING_SOURCE_URL} returned HTTP ${status}`).toBe(200);
  });

  it("carries a generation stamp that is actually recent", () => {
    const ts = doc?.about?.timestamp;
    expect(typeof ts).toBe("number");
    const ageDays = Math.floor((Date.now() - (ts as number) * 1000) / MS_PER_DAY);
    // The source regenerates weekly. If it has stopped, our data freezes with
    // it and last_verified would keep looking healthy — the exact blind spot
    // that let the previous source rot.
    expect(ageDays).toBeLessThanOrEqual(GATE_MAX_AGE_DAYS);
  });

  it("exposes the document shape the refresh script reads", () => {
    const hour = doc?.compute?.instance?.["e2-standard-2"]?.cost?.["us-central1"]?.hour;
    expect(typeof hour).toBe("number");
    expect(hour as number).toBeGreaterThan(0);

    const disk = doc?.compute?.storage?.["ssd"]?.cost?.["us-central1"]?.month;
    expect(typeof disk).toBe("number");

    const bucket = doc?.storage?.bucket?.["standard"]?.cost?.["us-central1"]?.month;
    expect(typeof bucket).toBe("number");
  });

  it("the bundled compute table still agrees with the live source", () => {
    const bundled = getGcpComputePricing()["us-central1"]?.["e2-standard-2"];
    const live = doc?.compute?.instance?.["e2-standard-2"]?.cost?.["us-central1"]?.hour;
    expect(typeof bundled).toBe("number");
    expect(typeof live).toBe("number");
    // Wide enough to absorb a genuine upstream price move between refreshes,
    // tight enough to catch the failure that matters: a refresh that ran and
    // wrote the wrong field.
    expect(Math.abs((bundled as number) - (live as number)) / (live as number)).toBeLessThan(0.15);
  });

  it("the bundled storage table still agrees with the live source", () => {
    const bundled = getGcpStoragePricing()["us-central1"]?.STANDARD;
    const live = doc?.storage?.bucket?.["standard"]?.cost?.["us-central1"]?.month;
    expect(typeof bundled).toBe("number");
    expect(typeof live).toBe("number");
    expect(Math.abs((bundled as number) - (live as number)) / (live as number)).toBeLessThan(0.15);
  });
});
