import type { CloudProvider, ResourceInventory, ParsedResource } from "../types/index.js";
import { parseHclToJson } from "./hcl-parser.js";
import { resolveVariables } from "./variable-resolver.js";
import {
  extractResources,
  detectRegionFromProviders,
} from "./resource-extractor.js";
import { detectProvider } from "./provider-detector.js";
import { logger } from "../logger.js";

export { parseHclToJson } from "./hcl-parser.js";
export { detectProvider } from "./provider-detector.js";
export { resolveVariables, substituteVariables } from "./variable-resolver.js";
export { extractResources, detectRegionFromProviders } from "./resource-extractor.js";

// ---------------------------------------------------------------------------
// Provider + region inference
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS: Record<CloudProvider, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
};

/**
 * Heuristically determine the primary provider from a set of parsed resources.
 * Returns the provider that appears most often, falling back to "aws" when the
 * set is empty or tied.
 */
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse one or more Terraform HCL files (and an optional .tfvars override
 * string) into a unified ResourceInventory.
 *
 * Processing steps:
 *  1. Parse each HCL file to JSON in parallel.
 *  2. Merge all parsed JSON objects to build a combined view of variables and
 *     provider blocks.
 *  3. Resolve variables (defaults + tfvars overrides).
 *  4. Detect the default region for each cloud provider from provider blocks.
 *  5. Extract resources from every file, applying the resolved variables.
 *  6. Build and return the ResourceInventory.
 */
export async function parseTerraform(
  files: { path: string; content: string }[],
  tfvarsContent?: string
): Promise<ResourceInventory> {
  const warnings: string[] = [];
  const parsedJsons: Array<{ path: string; json: Record<string, unknown> }> =
    [];

  // Step 1: Parse all files
  for (const file of files) {
    try {
      const json = await parseHclToJson(file.content, file.path);
      parsedJsons.push({ path: file.path, json });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      warnings.push(`Parse error in ${file.path}: ${msg}`);
      logger.warn("Skipping file due to parse error", {
        path: file.path,
        error: msg,
      });
    }
  }

  if (parsedJsons.length === 0) {
    logger.warn("No files were successfully parsed");
    return {
      provider: "aws",
      region: PROVIDER_DEFAULTS["aws"],
      resources: [],
      total_count: 0,
      by_type: {},
      parse_warnings: warnings,
    };
  }

  // Step 2: Merge all parsed JSONs into a single combined object for variable
  // and provider block resolution. Resources are extracted per-file below.
  const combined = mergeHclJsons(parsedJsons.map((p) => p.json));

  // Step 3: Resolve variables
  const variables = resolveVariables(combined, tfvarsContent);

  // Step 4: Detect region per provider from merged provider blocks
  const providers: CloudProvider[] = ["aws", "azure", "gcp"];
  const defaultRegions: Partial<Record<CloudProvider, string>> = {};
  for (const p of providers) {
    defaultRegions[p] = detectRegionFromProviders(combined, p, variables);
  }

  // Step 5: Extract resources from each file
  const allResources: ParsedResource[] = [];
  for (const { path, json } of parsedJsons) {
    try {
      const resources = extractResources(json, variables, path, defaultRegions, warnings);
      allResources.push(...resources);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Extraction error in ${path}: ${msg}`);
      logger.warn("Resource extraction failed", { path, error: msg });
    }
  }

  // Step 6: Build inventory
  const dominantProvider = inferDominantProvider(allResources);
  const dominantRegion =
    defaultRegions[dominantProvider] ?? PROVIDER_DEFAULTS[dominantProvider];

  const byType: Record<string, number> = {};
  for (const r of allResources) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }

  const inventory: ResourceInventory = {
    provider: dominantProvider,
    region: dominantRegion,
    resources: allResources,
    total_count: allResources.length,
    by_type: byType,
    parse_warnings: warnings,
  };

  logger.info("Terraform parse complete", {
    fileCount: files.length,
    resourceCount: allResources.length,
    provider: dominantProvider,
    region: dominantRegion,
    warningCount: warnings.length,
  });

  return inventory;
}

// ---------------------------------------------------------------------------
// Merge helper
// ---------------------------------------------------------------------------

/**
 * Shallow-merge multiple HCL JSON objects so that variable and provider block
 * information from separate files (e.g. variables.tf and main.tf) is visible
 * in one place during resolution. Block-level arrays are concatenated rather
 * than overwritten, and the `resource` section is merged at the type level.
 */
function mergeHclJsons(
  jsons: Record<string, unknown>[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const json of jsons) {
    for (const [key, value] of Object.entries(json)) {
      if (!(key in merged)) {
        merged[key] = deepClone(value);
        continue;
      }

      const existing = merged[key];

      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        // Recursively merge objects (handles provider, resource, variable blocks)
        merged[key] = mergeObjects(
          existing as Record<string, unknown>,
          value as Record<string, unknown>
        );
      } else if (Array.isArray(existing) && Array.isArray(value)) {
        merged[key] = [...existing, ...value];
      } else {
        // Scalar or incompatible types: last-writer wins
        merged[key] = deepClone(value);
      }
    }
  }

  return merged;
}

function mergeObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...a };
  for (const [key, bVal] of Object.entries(b)) {
    const aVal = result[key];
    if (
      aVal !== null &&
      typeof aVal === "object" &&
      !Array.isArray(aVal) &&
      bVal !== null &&
      typeof bVal === "object" &&
      !Array.isArray(bVal)
    ) {
      result[key] = mergeObjects(
        aVal as Record<string, unknown>,
        bVal as Record<string, unknown>
      );
    } else if (Array.isArray(aVal) && Array.isArray(bVal)) {
      result[key] = [...aVal, ...bVal];
    } else {
      result[key] = deepClone(bVal);
    }
  }
  return result;
}

function deepClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}
