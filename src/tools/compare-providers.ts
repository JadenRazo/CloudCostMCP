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
import { SUPPORTED_CURRENCIES, convertBreakdownCurrency, convertCurrency } from "../currency.js";
import { generateFocusReport } from "../reporting/focus-report.js";

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
    .enum(["markdown", "json", "csv", "focus"])
    .default("markdown")
    .describe("Output report format"),
  providers: z
    .array(z.enum(["aws", "azure", "gcp"]))
    .default(["aws", "azure", "gcp"])
    .describe("Cloud providers to include in the comparison"),
  currency: z
    .enum(SUPPORTED_CURRENCIES)
    .optional()
    .default("USD")
    .describe("Output currency for cost estimates. Defaults to USD."),
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
  // Savings percentages are computed on the original USD figures before any
  // currency conversion so the ratios remain accurate.
  const sourceBreakdown =
    comparisons.find((b) => b.provider === sourceProvider) ?? comparisons[0];
  const sourceMonthly = sourceBreakdown?.total_monthly ?? 0;

  const currency = params.currency ?? "USD";

  const convertedComparisons = currency !== "USD"
    ? comparisons.map((b) => convertBreakdownCurrency(b, currency))
    : comparisons;

  const savingsSummary: SavingsSummary[] = convertedComparisons.map((b) => {
    // Use original USD monthly figures for percentage calculation when converted.
    const bMonthlyUsd = currency !== "USD"
      ? (b as ReturnType<typeof convertBreakdownCurrency>).original_usd.total_monthly
      : b.total_monthly;
    const diff = b.total_monthly - convertCurrency(sourceMonthly, currency);
    const pct = sourceMonthly !== 0 ? ((bMonthlyUsd - sourceMonthly) / sourceMonthly) * 100 : 0;
    return {
      provider: b.provider,
      total_monthly: b.total_monthly,
      difference_from_source: Math.round(diff * 100) / 100,
      percentage_difference: Math.round(pct * 10) / 10,
    };
  });

  const comparison: ProviderComparison = {
    source_provider: sourceProvider,
    comparisons: convertedComparisons,
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
    case "focus":
      report = generateFocusReport(comparison, inventory.resources);
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

  const dedupedWarnings = [...new Set([...parseWarnings, ...allWarnings])];

  if (params.format === "json") {
    // The JSON report already contains the full structured data; returning
    // the raw comparison object on top would double the payload.
    return {
      report,
      format: params.format,
      warnings: dedupedWarnings,
    };
  }

  // For non-JSON formats, include a lightweight summary instead of the full
  // nested comparison object with all by_resource arrays.
  const comparisonSummary = {
    source_provider: comparison.source_provider,
    savings_summary: comparison.savings_summary,
    providers: convertedComparisons.map((b) => ({
      provider: b.provider,
      total_monthly: b.total_monthly,
      total_yearly: b.total_yearly,
      resource_count: b.by_resource.length,
    })),
  };

  return {
    report,
    format: params.format,
    comparison: comparisonSummary,
    warnings: dedupedWarnings,
  };
}
