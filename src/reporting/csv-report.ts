import type { ProviderComparison } from "../types/pricing.js";
import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { ReportOptions } from "../types/reports.js";

const PROVIDERS: CloudProvider[] = ["aws", "azure", "gcp"];

function csvEscape(value: string | number): string {
  const str = String(value);
  // Wrap in double quotes if the value contains a comma, newline, or quote.
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates a CSV report comparing monthly costs across all providers for
 * each resource.
 *
 * Default columns: Resource, Type, AWS Monthly, Azure Monthly, GCP Monthly, Cheapest
 *
 * When options.group_by === "tag" and options.group_by_tag_key is set, an
 * additional Tag Group column is appended to each row.
 */
export function generateCsvReport(
  comparison: ProviderComparison,
  resources: ParsedResource[],
  options: Partial<ReportOptions> = {}
): string {
  const lines: string[] = [];

  const tagKey = options.group_by === "tag" ? options.group_by_tag_key : undefined;

  // Comment header: not part of the CSV data but provides context to readers.
  lines.push("# Prices are estimates based on on-demand pricing. See assumptions in JSON/Markdown reports.");

  // Column header row — append tag_group column when tag grouping is active.
  const headerRow = tagKey
    ? "Resource,Type,AWS Monthly,Azure Monthly,GCP Monthly,Cheapest,Tag Group"
    : "Resource,Type,AWS Monthly,Azure Monthly,GCP Monthly,Cheapest";
  lines.push(headerRow);

  // Build a lookup: provider -> (resource_id -> monthly_cost).
  const costByProviderAndResource = new Map<string, Map<string, number>>();
  for (const breakdown of comparison.comparisons) {
    const byResource = new Map<string, number>();
    for (const estimate of breakdown.by_resource) {
      byResource.set(estimate.resource_id, estimate.monthly_cost);
    }
    costByProviderAndResource.set(breakdown.provider, byResource);
  }

  // One row per resource.
  for (const resource of resources) {
    const costs: Partial<Record<CloudProvider, number>> = {};
    for (const provider of PROVIDERS) {
      const providerMap = costByProviderAndResource.get(provider);
      if (providerMap) {
        costs[provider] = providerMap.get(resource.id) ?? 0;
      }
    }

    // Find the cheapest provider that has a non-zero cost.
    let cheapest = "N/A";
    let lowestCost = Infinity;
    for (const provider of PROVIDERS) {
      const cost = costs[provider] ?? 0;
      if (cost > 0 && cost < lowestCost) {
        lowestCost = cost;
        cheapest = provider.toUpperCase();
      }
    }

    const row = [
      csvEscape(resource.name),
      csvEscape(resource.type),
      csvEscape((costs.aws ?? 0).toFixed(2)),
      csvEscape((costs.azure ?? 0).toFixed(2)),
      csvEscape((costs.gcp ?? 0).toFixed(2)),
      csvEscape(cheapest),
    ];

    if (tagKey) {
      const tagVal = resource.tags[tagKey] ?? "Untagged";
      row.push(csvEscape(tagVal));
    }

    lines.push(row.join(","));
  }

  return lines.join("\n");
}
