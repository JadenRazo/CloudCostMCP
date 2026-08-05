import { describe, it, expect } from "vitest";
import type { z } from "zod";

import { MAX_TOTAL_FILE_BYTES, MAX_FILE_CONTENT_BYTES } from "../../../src/schemas/bounded.js";

import { analyzeTerraformSchema } from "../../../src/tools/analyze-terraform.js";
import { estimateCostSchema } from "../../../src/tools/estimate-cost.js";
import { compareProvidersSchema } from "../../../src/tools/compare-providers.js";
import { optimizeCostSchema } from "../../../src/tools/optimize-cost.js";
import { whatIfSchema } from "../../../src/tools/what-if.js";
import { compareActualSchema } from "../../../src/tools/compare-actual.js";
import { detectAnomaliesSchema } from "../../../src/tools/detect-anomalies.js";
import { checkCostBudgetSchema } from "../../../src/tools/check-cost-budget.js";

import { getEquivalentsSchema } from "../../../src/tools/get-equivalents.js";
import { getPricingSchema } from "../../../src/tools/get-pricing.js";
import { analyzePlanSchema } from "../../../src/tools/analyze-plan.js";
import { priceTrendsSchema } from "../../../src/tools/price-trends.js";

/**
 * Regression guard for the aggregate files[] byte cap.
 *
 * The per-file limit alone is insufficient: 2000 files x 5 MiB each is a
 * theoretical 10 GiB payload that passes per-entry validation. Every tool
 * whose schema accepts a `files` array MUST enforce
 * `assertTotalFileBytesWithin` so the *sum* of file contents is bounded.
 *
 * This test loops over ALL registered tool schemas. Any schema that exposes
 * a `files` field is automatically subjected to the cap assertion, so a new
 * files-accepting tool that forgets the shared `iacFilesSchema` fragment
 * fails here rather than shipping unbounded.
 */

// Every tool schema registered in src/tools/index.ts. Keep in sync with
// registerTools() — the completeness check below trips when a schema in this
// list accepts `files` without the aggregate cap.
const ALL_TOOL_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  analyze_terraform: analyzeTerraformSchema,
  estimate_cost: estimateCostSchema,
  compare_providers: compareProvidersSchema,
  get_equivalents: getEquivalentsSchema,
  get_pricing: getPricingSchema,
  optimize_cost: optimizeCostSchema,
  what_if: whatIfSchema,
  analyze_plan: analyzePlanSchema,
  compare_actual: compareActualSchema,
  price_trends: priceTrendsSchema,
  detect_anomalies: detectAnomaliesSchema,
  check_cost_budget: checkCostBudgetSchema,
};

/** Tool schemas that expose a `files` field, discovered from the shape. */
const filesAcceptingSchemas = Object.entries(ALL_TOOL_SCHEMAS).filter(
  ([, schema]) => "files" in schema.shape,
);

// Each entry stays within the per-file cap; the sum exceeds the aggregate cap.
// The same string instance is reused so the payload is cheap to build.
const chunk = "a".repeat(MAX_FILE_CONTENT_BYTES);
const entriesNeeded = Math.floor(MAX_TOTAL_FILE_BYTES / MAX_FILE_CONTENT_BYTES) + 1;
const oversizedFiles = Array.from({ length: entriesNeeded }, (_, i) => ({
  path: `f${i}.tf`,
  content: chunk,
}));

const smallFiles = [{ path: "main.tf", content: 'resource "aws_instance" "a" {}' }];

function aggregateIssues(result: z.ZodSafeParseResult<unknown>) {
  if (result.success) return [];
  return result.error.issues.filter(
    (issue) => issue.path[0] === "files" && /aggregate file content exceeds/.test(issue.message),
  );
}

describe("aggregate files[] byte cap (DoS guard)", () => {
  it("covers every files-accepting tool (sanity: at least the 8 known tools)", () => {
    const names = filesAcceptingSchemas.map(([name]) => name).sort();
    expect(names).toEqual(
      [
        "analyze_terraform",
        "check_cost_budget",
        "compare_actual",
        "compare_providers",
        "detect_anomalies",
        "estimate_cost",
        "optimize_cost",
        "what_if",
      ].sort(),
    );
  });

  it.each(filesAcceptingSchemas.map(([name, schema]) => [name, schema] as const))(
    "%s rejects files[] whose total content exceeds MAX_TOTAL_FILE_BYTES",
    (_name, schema) => {
      const result = schema.safeParse({ files: oversizedFiles });
      expect(result.success).toBe(false);
      // The failure must specifically be the aggregate cap on `files` —
      // missing sibling fields also produce issues, so filter precisely.
      expect(aggregateIssues(result).length).toBeGreaterThan(0);
    },
  );

  it.each(filesAcceptingSchemas.map(([name, schema]) => [name, schema] as const))(
    "%s accepts a small files[] payload (cap does not over-trigger)",
    (_name, schema) => {
      const result = schema.safeParse({ files: smallFiles });
      // Other required fields may still be missing; the aggregate-cap issue
      // specifically must not be present.
      expect(aggregateIssues(result)).toHaveLength(0);
    },
  );
});
