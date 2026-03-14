import type { ProviderComparison } from "../types/pricing.js";
import type { ParsedResource } from "../types/resources.js";
import type { ReportOptions } from "../types/reports.js";

/**
 * Generates a pretty-printed JSON representation of the full provider
 * comparison, augmented with a metadata section and a resource summary.
 *
 * The metadata section contains:
 *  - generated_at timestamp
 *  - pricing_sources_used (unique sources referenced across all estimates)
 *  - assumptions (static estimation parameters)
 *  - warnings (data quality issues collected across all breakdowns)
 *
 * When options.group_by === "tag" and options.group_by_tag_key is set, a
 * cost_by_tag object is included in the output.
 */
export function generateJsonReport(
  comparison: ProviderComparison,
  resources: ParsedResource[],
  monthlyHours: number = 730,
  parseWarnings: string[] = [],
  options: Partial<ReportOptions> = {}
): string {
  // Collect unique pricing sources across all resource estimates.
  const sourcesSet = new Set<string>();
  for (const breakdown of comparison.comparisons) {
    for (const estimate of breakdown.by_resource) {
      const src = estimate.pricing_source;
      if (src) {
        sourcesSet.add(`${breakdown.provider}_${src}`);
      }
    }
  }

  // Aggregate all data quality warnings, deduplicated.
  const allDataWarnings = comparison.comparisons.flatMap((b) => b.warnings ?? []);
  const allWarnings = [...new Set([...parseWarnings, ...allDataWarnings])];

  // Build resource_id -> source-provider monthly cost for tag grouping.
  const tagKey = options.group_by === "tag" ? options.group_by_tag_key : undefined;

  let costByTag: Record<string, unknown> | undefined;

  if (tagKey) {
    const sourceProvider =
      comparison.source_provider ?? comparison.comparisons[0]?.provider;

    // Build resource_id -> monthly cost from the source provider breakdown.
    const costById = new Map<string, number>();
    for (const breakdown of comparison.comparisons) {
      if (breakdown.provider === sourceProvider) {
        for (const estimate of breakdown.by_resource) {
          costById.set(estimate.resource_id, estimate.monthly_cost);
        }
      }
    }

    // Accumulate per-tag-value totals.
    const groups: Record<string, { resource_count: number; monthly_cost: number }> = {};
    for (const resource of resources) {
      const tagVal = resource.tags[tagKey] ?? "Untagged";
      const current = groups[tagVal] ?? { resource_count: 0, monthly_cost: 0 };
      current.resource_count += 1;
      current.monthly_cost += costById.get(resource.id) ?? 0;
      groups[tagVal] = current;
    }

    // Round monthly_cost to two decimal places for clean JSON output.
    for (const val of Object.values(groups)) {
      val.monthly_cost = Math.round(val.monthly_cost * 100) / 100;
    }

    costByTag = { tag_key: tagKey, groups };
  }

  const output: Record<string, unknown> = {
    metadata: {
      generated_at: new Date().toISOString(),
      pricing_sources_used: Array.from(sourcesSet).sort(),
      assumptions: {
        pricing_model: "on-demand",
        operating_system: "Linux (unless specified)",
        monthly_hours: monthlyHours,
        currency: "USD",
        data_transfer_costs: "not included",
        tax: "not included",
      },
      warnings: allWarnings,
    },
    ...comparison,
    resource_summary: {
      total: resources.length,
      by_type: resources.reduce<Record<string, number>>((acc, r) => {
        acc[r.type] = (acc[r.type] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };

  if (costByTag !== undefined) {
    output.cost_by_tag = costByTag;
  }

  return JSON.stringify(output);
}
