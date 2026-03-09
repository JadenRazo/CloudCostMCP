import type { ProviderComparison } from "../types/pricing.js";
import type { ParsedResource } from "../types/resources.js";

/**
 * Generates a pretty-printed JSON representation of the full provider
 * comparison, augmented with a metadata section and a resource summary.
 *
 * The metadata section contains:
 *  - generated_at timestamp
 *  - pricing_sources_used (unique sources referenced across all estimates)
 *  - assumptions (static estimation parameters)
 *  - warnings (data quality issues collected across all breakdowns)
 */
export function generateJsonReport(
  comparison: ProviderComparison,
  resources: ParsedResource[],
  monthlyHours: number = 730,
  parseWarnings: string[] = []
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

  const output = {
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

  return JSON.stringify(output, null, 2);
}
