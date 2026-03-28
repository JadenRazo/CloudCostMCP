import type { IaCParser, FileInput, ParseOptions } from "../iac-parser.js";
import type { CloudProvider, ParsedResource, ResourceInventory } from "../../types/resources.js";
import type { PulumiStackExport } from "./pulumi-types.js";
import { mapPulumiResource } from "./pulumi-resource-mapper.js";
import { logger } from "../../logger.js";

export class PulumiParser implements IaCParser {
  readonly name = "Pulumi";
  readonly extensions = [".json"] as const;

  detect(files: FileInput[]): boolean {
    return files.some((f) => {
      try {
        const data = JSON.parse(f.content) as Record<string, unknown>;
        const deployment = data?.deployment as Record<string, unknown> | undefined;
        return deployment?.resources !== undefined;
      } catch {
        return false;
      }
    });
  }

  async parse(files: FileInput[], _options?: ParseOptions): Promise<ResourceInventory> {
    const warnings: string[] = [];

    // Find the first file that looks like a Pulumi stack export
    const file = files.find((f) => {
      try {
        const data = JSON.parse(f.content) as Record<string, unknown>;
        const deployment = data?.deployment as Record<string, unknown> | undefined;
        return deployment?.resources !== undefined;
      } catch {
        return false;
      }
    });

    if (!file) {
      return emptyInventory(warnings);
    }

    let stackExport: PulumiStackExport;
    try {
      stackExport = JSON.parse(file.content) as PulumiStackExport;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to parse Pulumi stack export ${file.path}: ${msg}`);
      logger.warn("Pulumi parse error", { path: file.path, error: msg });
      return emptyInventory(warnings);
    }

    if (!stackExport?.deployment?.resources || !Array.isArray(stackExport.deployment.resources)) {
      warnings.push(`Invalid Pulumi stack export: missing deployment.resources in ${file.path}`);
      return emptyInventory(warnings);
    }

    // Map resources, skipping Pulumi internal types (pulumi:pulumi:Stack, pulumi:providers:*)
    const resources: ParsedResource[] = [];
    for (const pulumiRes of stackExport.deployment.resources) {
      if (pulumiRes.type.startsWith("pulumi:")) {
        continue;
      }

      const parsed = mapPulumiResource(pulumiRes, warnings);
      if (parsed) {
        parsed.source_file = file.path;
        resources.push(parsed);
      }
    }

    // Determine dominant provider and region
    const dominantProvider = inferDominantProvider(resources);
    const dominantRegion = inferDominantRegion(resources, dominantProvider);

    // Build by_type counts
    const byType: Record<string, number> = {};
    for (const r of resources) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
    }

    const inventory: ResourceInventory = {
      provider: dominantProvider,
      region: dominantRegion,
      resources,
      total_count: resources.length,
      by_type: byType,
      parse_warnings: warnings,
    };

    logger.info("Pulumi parse complete", {
      path: file.path,
      resourceCount: resources.length,
      provider: dominantProvider,
      region: dominantRegion,
      warningCount: warnings.length,
    });

    return inventory;
  }
}

function emptyInventory(warnings: string[]): ResourceInventory {
  return {
    provider: "aws",
    region: "us-east-1",
    resources: [],
    total_count: 0,
    by_type: {},
    parse_warnings: warnings,
  };
}

const PROVIDER_DEFAULTS: Record<CloudProvider, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
};

function inferDominantProvider(resources: ParsedResource[]): CloudProvider {
  if (resources.length === 0) return "aws";

  const counts: Partial<Record<CloudProvider, number>> = {};
  for (const r of resources) {
    counts[r.provider] = (counts[r.provider] ?? 0) + 1;
  }

  let dominant: CloudProvider = "aws";
  let max = 0;
  for (const [p, c] of Object.entries(counts) as [CloudProvider, number][]) {
    if (c > max) {
      max = c;
      dominant = p;
    }
  }
  return dominant;
}

function inferDominantRegion(resources: ParsedResource[], provider: CloudProvider): string {
  const matching = resources.filter((r) => r.provider === provider);
  if (matching.length === 0) return PROVIDER_DEFAULTS[provider];

  // Use the region of the first resource from the dominant provider
  return matching[0].region;
}
