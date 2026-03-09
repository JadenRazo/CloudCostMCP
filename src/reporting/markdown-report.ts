import type { ProviderComparison, CostBreakdown } from "../types/pricing.js";
import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { ReportOptions } from "../types/reports.js";
import { generateOptimizations } from "../calculator/optimizer.js";

const PROVIDERS: CloudProvider[] = ["aws", "azure", "gcp"];

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function providerLabel(provider: CloudProvider): string {
  switch (provider) {
    case "aws":
      return "AWS";
    case "azure":
      return "Azure";
    case "gcp":
      return "GCP";
  }
}

/**
 * Generates a Markdown cost comparison report.
 *
 * Sections:
 *  1. Title and generation date
 *  2. Summary table (provider, monthly cost, yearly cost, vs source)
 *  3. Per-resource breakdown table (resource, type, cost per provider)
 *  4. Savings recommendations (if include_recommendations is true)
 *  5. Assumptions
 *  6. Limitations (only when parse warnings or data quality warnings exist)
 */
export function generateMarkdownReport(
  comparison: ProviderComparison,
  resources: ParsedResource[],
  options: Partial<ReportOptions> = {},
  parseWarnings: string[] = []
): string {
  const includeBreakdown = options.include_breakdown !== false;
  const includeRecommendations = options.include_recommendations !== false;
  const monthlyHours = (options as { monthly_hours?: number }).monthly_hours ?? 730;

  const lines: string[] = [];
  const now = new Date().toISOString().split("T")[0];

  // ---------------------------------------------------------------------------
  // Title
  // ---------------------------------------------------------------------------
  lines.push(
    `# Cloud Cost Comparison Report`,
    ``,
    `**Generated:** ${now}  `,
    `**Source provider:** ${providerLabel(comparison.source_provider)}  `,
    `**Resources analysed:** ${resources.length}`,
    ``
  );

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------
  lines.push(`## Summary`, ``);

  // Find source provider breakdown for "vs source" column.
  const sourceBreakdown = comparison.comparisons.find(
    (b) => b.provider === comparison.source_provider
  );
  const sourceMonthly = sourceBreakdown?.total_monthly ?? 0;

  lines.push(
    `| Provider | Monthly Cost | Yearly Cost | vs Source |`,
    `|----------|-------------|------------|-----------|`
  );

  for (const breakdown of comparison.comparisons) {
    const diff = breakdown.total_monthly - sourceMonthly;
    const diffLabel =
      breakdown.provider === comparison.source_provider
        ? "—"
        : diff < 0
        ? `${formatUsd(Math.abs(diff))} cheaper`
        : diff > 0
        ? `${formatUsd(diff)} more expensive`
        : "same cost";

    lines.push(
      `| ${providerLabel(breakdown.provider)} | ${formatUsd(breakdown.total_monthly)} | ${formatUsd(breakdown.total_yearly)} | ${diffLabel} |`
    );
  }
  lines.push(``);

  // ---------------------------------------------------------------------------
  // Savings summary
  // ---------------------------------------------------------------------------
  if (comparison.savings_summary.length > 0) {
    lines.push(`## Savings Potential`, ``);
    lines.push(
      `| Provider | Monthly Cost | Savings from Source | Savings % |`,
      `|----------|-------------|--------------------|-----------| `
    );
    for (const s of comparison.savings_summary) {
      const savings = s.difference_from_source;
      const savingsLabel =
        savings < 0
          ? formatUsd(Math.abs(savings))
          : `-${formatUsd(savings)}`;
      const pct =
        s.percentage_difference < 0
          ? `${Math.abs(s.percentage_difference).toFixed(1)}% cheaper`
          : `${s.percentage_difference.toFixed(1)}% more`;
      lines.push(
        `| ${providerLabel(s.provider)} | ${formatUsd(s.total_monthly)} | ${savingsLabel} | ${pct} |`
      );
    }
    lines.push(``);
  }

  // ---------------------------------------------------------------------------
  // Per-resource breakdown
  // ---------------------------------------------------------------------------
  if (includeBreakdown && resources.length > 0) {
    lines.push(`## Resource Breakdown`, ``);

    // Build: resource_id -> provider -> monthly_cost
    const costMatrix = new Map<string, Partial<Record<CloudProvider, number>>>();

    for (const breakdown of comparison.comparisons) {
      for (const estimate of breakdown.by_resource) {
        const row = costMatrix.get(estimate.resource_id) ?? {};
        row[breakdown.provider] = estimate.monthly_cost;
        costMatrix.set(estimate.resource_id, row);
      }
    }

    // Table header – only include columns for providers that appear in the comparison.
    const presentProviders = comparison.comparisons.map((b) => b.provider);
    const headerCols = presentProviders
      .map((p) => providerLabel(p))
      .join(" | ");

    lines.push(
      `| Resource | Type | ${headerCols} |`,
      `|----------|------|${presentProviders.map(() => "------").join("|")}|`
    );

    for (const resource of resources) {
      const costs = costMatrix.get(resource.id) ?? {};
      const costCols = presentProviders
        .map((p) => formatUsd(costs[p] ?? 0))
        .join(" | ");
      lines.push(
        `| ${resource.name} | ${resource.type} | ${costCols} |`
      );
    }
    lines.push(``);
  }

  // ---------------------------------------------------------------------------
  // Optimisation recommendations
  // ---------------------------------------------------------------------------
  if (includeRecommendations) {
    // Collect all estimates across all provider breakdowns.
    const allEstimates = comparison.comparisons.flatMap((b) => b.by_resource);
    const recommendations = generateOptimizations(allEstimates, resources);

    if (recommendations.length > 0) {
      lines.push(`## Savings Recommendations`, ``);

      for (const rec of recommendations) {
        const savingsLabel = `${formatUsd(rec.monthly_savings)}/month (${rec.percentage_savings}%)`;
        lines.push(
          `### ${rec.resource_name} – ${rec.type.replace(/_/g, " ")}`,
          ``,
          `${rec.description}`,
          ``,
          `- **Current cost:** ${formatUsd(rec.current_monthly_cost)}/month`,
          `- **Estimated after:** ${formatUsd(rec.estimated_monthly_cost)}/month`,
          `- **Potential savings:** ${savingsLabel}`,
          `- **Confidence:** ${rec.confidence}`,
          ``
        );
      }
    } else {
      lines.push(`## Savings Recommendations`, ``, `No recommendations at this time.`, ``);
    }
  }

  // ---------------------------------------------------------------------------
  // Assumptions
  // ---------------------------------------------------------------------------
  lines.push(`## Assumptions`, ``);
  lines.push(
    `| Parameter | Value |`,
    `|-----------|-------|`,
    `| Pricing model | On-demand (no reserved or spot instances) |`,
    `| Operating system | Linux (unless specified in resource attributes) |`,
    `| Monthly hours | ${monthlyHours} |`,
    `| Currency | USD |`,
    `| Pricing source | Mix of live API and fallback/bundled data |`,
    `| Data transfer costs | Not included |`,
    `| Tax | Not included |`,
    ``
  );

  // ---------------------------------------------------------------------------
  // Limitations
  // ---------------------------------------------------------------------------
  // Collect all data quality warnings across all provider breakdowns.
  const allDataWarnings = comparison.comparisons.flatMap((b) => b.warnings ?? []);
  const allWarnings = [...new Set([...parseWarnings, ...allDataWarnings])];

  if (allWarnings.length > 0) {
    lines.push(`## Limitations`, ``);
    lines.push(
      `> The following issues were detected during analysis that may affect estimate accuracy:`,
      ``
    );
    for (const w of allWarnings) {
      lines.push(`- ${w}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}
