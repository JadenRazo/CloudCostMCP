import type { ProviderComparison, CostBreakdown } from "../types/pricing.js";
import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { ReportOptions } from "../types/reports.js";
import { generateOptimizations } from "../calculator/optimizer.js";
import { calculateProjection } from "../calculator/projection.js";
import { calculateReservedPricing } from "../calculator/reserved.js";

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
    const headerCols = presentProviders.map((p) => providerLabel(p)).join(" | ");

    const tagKey = options.group_by === "tag" ? options.group_by_tag_key : undefined;

    if (tagKey) {
      // -----------------------------------------------------------------------
      // Tag grouping: build group map before the detail section
      // -----------------------------------------------------------------------

      // Group resources by their tag value, falling back to "Untagged".
      const tagGroups = new Map<string, ParsedResource[]>();
      for (const resource of resources) {
        const tagVal = resource.tags[tagKey] ?? "Untagged";
        const bucket = tagGroups.get(tagVal) ?? [];
        bucket.push(resource);
        tagGroups.set(tagVal, bucket);
      }

      // Compute per-group monthly totals using the source provider's costs
      // (or the first available provider when source is not present).
      const sourceProvider =
        comparison.source_provider ?? comparison.comparisons[0]?.provider;

      const groupTotals = new Map<string, { count: number; monthly: number }>();
      for (const [tagVal, groupResources] of tagGroups) {
        let groupMonthly = 0;
        for (const resource of groupResources) {
          const costs = costMatrix.get(resource.id) ?? {};
          groupMonthly += costs[sourceProvider] ?? 0;
        }
        groupTotals.set(tagVal, { count: groupResources.length, monthly: groupMonthly });
      }

      // Cost by Tag summary table.
      lines.push(`## Cost by Tag`, ``);
      lines.push(`**Tag key:** \`${tagKey}\``, ``);
      lines.push(
        `| Tag Value | Resource Count | Monthly Cost |`,
        `|-----------|---------------|-------------|`
      );

      // Sort: Untagged last, everything else alphabetically.
      const sortedTagValues = Array.from(tagGroups.keys()).sort((a, b) => {
        if (a === "Untagged") return 1;
        if (b === "Untagged") return -1;
        return a.localeCompare(b);
      });

      for (const tagVal of sortedTagValues) {
        const totals = groupTotals.get(tagVal)!;
        lines.push(`| ${tagVal} | ${totals.count} | ${formatUsd(totals.monthly)} |`);
      }
      lines.push(``);

      // Detailed breakdown organised under tag group headings.
      lines.push(`## Resource Breakdown`, ``);

      for (const tagVal of sortedTagValues) {
        const groupResources = tagGroups.get(tagVal)!;
        lines.push(`### ${tagVal}`, ``);
        lines.push(
          `| Resource | Type | ${headerCols} |`,
          `|----------|------|${presentProviders.map(() => "------").join("|")}|`
        );
        for (const resource of groupResources) {
          const costs = costMatrix.get(resource.id) ?? {};
          const costCols = presentProviders
            .map((p) => formatUsd(costs[p] ?? 0))
            .join(" | ");
          lines.push(`| ${resource.name} | ${resource.type} | ${costCols} |`);
        }
        lines.push(``);
      }
    } else {
      // -----------------------------------------------------------------------
      // Default: flat resource breakdown table
      // -----------------------------------------------------------------------
      lines.push(`## Resource Breakdown`, ``);
      lines.push(
        `| Resource | Type | ${headerCols} |`,
        `|----------|------|${presentProviders.map(() => "------").join("|")}|`
      );

      for (const resource of resources) {
        const costs = costMatrix.get(resource.id) ?? {};
        const costCols = presentProviders
          .map((p) => formatUsd(costs[p] ?? 0))
          .join(" | ");
        lines.push(`| ${resource.name} | ${resource.type} | ${costCols} |`);
      }
      lines.push(``);
    }
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
  // Cost Projection
  // ---------------------------------------------------------------------------
  if (sourceMonthly > 0) {
    // Build reserved input from the source provider's monthly total if we have it.
    const reservedComparison = sourceBreakdown
      ? calculateReservedPricing(sourceBreakdown.total_monthly, comparison.source_provider)
      : null;

    const reservedInput = reservedComparison
      ? { best_reserved: { monthly_cost: reservedComparison.best_option.monthly_cost, term: reservedComparison.best_option.term } }
      : null;

    const projection = calculateProjection(sourceMonthly, reservedInput);

    lines.push(`## Cost Projection`, ``);
    lines.push(
      `| Timeframe | On-Demand | Reserved | Savings | Savings % |`,
      `|-----------|-----------|----------|---------|-----------|`
    );

    for (const p of projection.projections) {
      const timeLabel = p.months === 1 ? "1 month" : `${p.months} months`;
      const reservedCol = p.reserved_total !== null ? formatUsd(p.reserved_total) : "N/A";
      const savingsCol = p.savings !== null ? formatUsd(p.savings) : "N/A";
      const savingsPctCol = p.savings_percentage !== null ? `${p.savings_percentage.toFixed(1)}%` : "N/A";
      lines.push(
        `| ${timeLabel} | ${formatUsd(p.on_demand_total)} | ${reservedCol} | ${savingsCol} | ${savingsPctCol} |`
      );
    }
    lines.push(``);

    if (projection.break_even_month !== null) {
      lines.push(
        `> Reserved pricing breaks even at **month ${projection.break_even_month}** compared to on-demand.`
      );
      if (projection.recommended_commitment !== null) {
        lines.push(
          `> Recommended commitment: **${projection.recommended_commitment}**.`
        );
      }
      lines.push(``);
    }
  }

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
