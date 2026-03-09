import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { ProviderComparison, CostBreakdown, SavingsSummary } from "../types/pricing.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { parseTerraform } from "../parsers/index.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { CostEngine } from "../calculator/cost-engine.js";
import { generateMarkdownReport } from "../reporting/markdown-report.js";
import { generateJsonReport } from "../reporting/json-report.js";
import { generateCsvReport } from "../reporting/csv-report.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const compareProvidersSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("File path"),
      content: z.string().describe("File content (HCL)"),
    })
  ),
  tfvars: z.string().optional().describe("Contents of terraform.tfvars file"),
  format: z
    .enum(["markdown", "json", "csv"])
    .default("markdown")
    .describe("Output report format"),
  providers: z
    .array(z.enum(["aws", "azure", "gcp"]))
    .default(["aws", "azure", "gcp"])
    .describe("Cloud providers to include in the comparison"),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Parse the supplied Terraform files, calculate costs across all requested
 * providers, and return a formatted report together with the raw comparison
 * data.
 */
export async function compareProviders(
  params: z.infer<typeof compareProvidersSchema>,
  pricingEngine: PricingEngine,
  config: CloudCostConfig
): Promise<object> {
  const inventory = await parseTerraform(params.files, params.tfvars);
  const sourceProvider = inventory.provider;
  const costEngine = new CostEngine(pricingEngine, config);
  const comparisons: CostBreakdown[] = [];

  for (const provider of params.providers as CloudProvider[]) {
    const targetRegion = mapRegion(inventory.region, sourceProvider, provider);
    const breakdown = await costEngine.calculateBreakdown(
      inventory.resources,
      provider,
      targetRegion
    );
    comparisons.push(breakdown);
  }

  // Build a savings summary relative to the source provider breakdown (or the
  // first breakdown when the source provider was not requested).
  const sourceBreakdown =
    comparisons.find((b) => b.provider === sourceProvider) ?? comparisons[0];
  const sourceMonthly = sourceBreakdown?.total_monthly ?? 0;

  const savingsSummary: SavingsSummary[] = comparisons.map((b) => {
    const diff = b.total_monthly - sourceMonthly;
    const pct =
      sourceMonthly !== 0 ? (diff / sourceMonthly) * 100 : 0;
    return {
      provider: b.provider,
      total_monthly: b.total_monthly,
      difference_from_source: Math.round(diff * 100) / 100,
      percentage_difference: Math.round(pct * 10) / 10,
    };
  });

  const comparison: ProviderComparison = {
    source_provider: sourceProvider,
    comparisons,
    savings_summary: savingsSummary,
    generated_at: new Date().toISOString(),
  };

  // Aggregate warnings for use in reports.
  const allWarnings = comparisons.flatMap((b) => b.warnings ?? []);
  const parseWarnings = inventory.parse_warnings ?? [];
  const monthlyHours = config.pricing.monthly_hours;

  // Format the report according to the requested format.
  let report: string;
  switch (params.format) {
    case "json":
      report = generateJsonReport(comparison, inventory.resources, monthlyHours, parseWarnings);
      break;
    case "csv":
      report = generateCsvReport(comparison, inventory.resources);
      break;
    case "markdown":
    default:
      report = generateMarkdownReport(
        comparison,
        inventory.resources,
        {},
        parseWarnings
      );
      break;
  }

  return {
    report,
    format: params.format,
    comparison,
    warnings: [...new Set([...parseWarnings, ...allWarnings])],
  };
}
