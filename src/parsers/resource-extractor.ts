import type { ParsedResource, ResourceAttributes, CloudProvider } from "../types/index.js";
import { detectProvider } from "./provider-detector.js";
import { substituteVariables } from "./variable-resolver.js";
import { logger } from "../logger.js";
import { str, num } from "./extractors/helpers.js";
import type { AttributeExtractor } from "./extractors/helpers.js";
import { awsExtractors } from "./extractors/aws-extractor.js";
import { azureExtractors } from "./extractors/azure-extractor.js";
import { gcpExtractors } from "./extractors/gcp-extractor.js";

// ---------------------------------------------------------------------------
// Region detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect the default region for a given provider by inspecting the top-level
 * `provider` block in the parsed HCL JSON. Falls back to a sensible default
 * when no region can be found.
 */
export function detectRegionFromProviders(
  hclJson: Record<string, unknown>,
  provider: CloudProvider,
  variables: Record<string, unknown>,
): string {
  const defaults: Record<CloudProvider, string> = {
    aws: "us-east-1",
    azure: "eastus",
    gcp: "us-central1",
  };

  const providerBlock = hclJson["provider"];
  if (!providerBlock || typeof providerBlock !== "object") {
    return defaults[provider];
  }

  const providerKeyMap: Record<CloudProvider, string> = {
    aws: "aws",
    azure: "azurerm",
    gcp: "google",
  };

  const key = providerKeyMap[provider];
  const declarations = (providerBlock as Record<string, unknown>)[key];
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return defaults[provider];
  }

  const declaration = declarations[0] as Record<string, unknown>;

  // Region attribute name varies per provider
  const regionAttr = provider === "azure" ? "location" : "region";
  const rawRegion = declaration[regionAttr];
  if (!rawRegion) return defaults[provider];

  const resolved = substituteVariables(rawRegion, variables);
  if (typeof resolved === "string" && resolved && !resolved.startsWith("${")) {
    return resolved;
  }

  return defaults[provider];
}

// ---------------------------------------------------------------------------
// Per-resource-type attribute extraction
// ---------------------------------------------------------------------------

const extractors: Record<string, AttributeExtractor> = {
  ...awsExtractors,
  ...azureExtractors,
  ...gcpExtractors,
};

// ---------------------------------------------------------------------------
// Region from resource-level attributes
// ---------------------------------------------------------------------------

/**
 * Some resource types carry their own region/zone/location attribute that can
 * be used as a fallback when no provider block region is available.
 */
function regionFromResourceBlock(
  resourceType: string,
  block: Record<string, unknown>,
  provider: CloudProvider,
): string | undefined {
  switch (provider) {
    case "azure": {
      const loc = str(block["location"]);
      return loc && !loc.startsWith("${") ? loc : undefined;
    }
    case "gcp": {
      // zone like "us-central1-a" -> strip suffix
      const zone = str(block["zone"]);
      if (zone && !zone.startsWith("${")) {
        const parts = zone.split("-");
        return parts.length > 2 ? parts.slice(0, -1).join("-") : zone;
      }
      return str(block["region"]);
    }
    case "aws": {
      const az = str(block["availability_zone"]);
      if (az && !az.startsWith("${")) {
        const parts = az.split("-");
        return parts.length > 2 ? parts.slice(0, -1).join("-") : az;
      }
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

function extractTags(block: Record<string, unknown>): Record<string, string> {
  const tags = block["tags"];
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
    else if (v !== null && v !== undefined) result[k] = String(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// count / for_each expansion helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `count` attribute to a concrete integer. Returns the count and
 * pushes a warning into the provided array when the value cannot be resolved.
 */
function resolveCount(rawCount: unknown, resourceId: string, warnings: string[]): number {
  const n = num(rawCount);
  if (n !== undefined && Number.isInteger(n) && n >= 0) return n;

  // Could be a variable reference or expression that wasn't resolved
  warnings.push(
    `Resource "${resourceId}" has a count that could not be resolved to a number. Defaulting to 1.`,
  );
  return 1;
}

/**
 * Resolve a `for_each` attribute to an array of keys. When the value is an
 * object, the object's keys are used. When it is an array, each element
 * (coerced to string) becomes a key. When neither can be determined a warning
 * is pushed and a single-element array `["0"]` is returned (equivalent to
 * count = 1).
 */
function resolveForEachKeys(rawForEach: unknown, resourceId: string, warnings: string[]): string[] {
  if (rawForEach && typeof rawForEach === "object" && !Array.isArray(rawForEach)) {
    const keys = Object.keys(rawForEach as Record<string, unknown>);
    if (keys.length > 0) return keys;
  }

  if (Array.isArray(rawForEach) && rawForEach.length > 0) {
    return rawForEach.map((v, i) =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : String(i),
    );
  }

  // Unresolvable (e.g. still a variable reference string)
  warnings.push(
    `Resource "${resourceId}" has a for_each that could not be resolved. Defaulting to 1 instance.`,
  );
  return ["0"];
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Walk the `resource` map in parsed HCL JSON and produce a flat array of
 * ParsedResource objects. Variable substitution is applied to all attribute
 * values before extraction so that downstream consumers always see resolved
 * strings/numbers wherever possible.
 *
 * count and for_each meta-arguments are expanded into multiple resources.
 * Data source blocks are silently skipped. Module blocks generate informational
 * warnings without being expanded.
 */
export function extractResources(
  hclJson: Record<string, unknown>,
  variables: Record<string, unknown>,
  sourceFile: string,
  defaultRegions: Partial<Record<CloudProvider, string>> = {},
  warnings: string[] = [],
): ParsedResource[] {
  const resources: ParsedResource[] = [];

  const resourceBlock = hclJson["resource"];

  if (!resourceBlock || typeof resourceBlock !== "object") {
    return resources;
  }

  for (const [resourceType, instances] of Object.entries(
    resourceBlock as Record<string, unknown>,
  )) {
    let provider: CloudProvider;
    try {
      provider = detectProvider(resourceType);
    } catch {
      logger.warn("Skipping resource with unknown provider prefix", {
        resourceType,
      });
      continue;
    }

    if (!instances || typeof instances !== "object" || Array.isArray(instances)) {
      continue;
    }

    for (const [resourceName, blockList] of Object.entries(instances as Record<string, unknown>)) {
      if (!Array.isArray(blockList) || blockList.length === 0) continue;

      const rawBlock = blockList[0] as Record<string, unknown>;
      // Substitute variables throughout the entire block before extraction
      const block = substituteVariables(rawBlock, variables) as Record<string, unknown>;

      // Determine region: resource-level > provider default > hard default
      const resourceRegion = regionFromResourceBlock(resourceType, block, provider);
      const region =
        resourceRegion ??
        defaultRegions[provider] ??
        (provider === "aws" ? "us-east-1" : provider === "azure" ? "eastus" : "us-central1");

      // Extract cost-relevant attributes using per-type extractor or generic
      const extractor = extractors[resourceType];
      const attributes: ResourceAttributes = extractor ? extractor(block) : {};

      const tags = extractTags(block);
      const baseId = `${resourceType}.${resourceName}`;

      // ------------------------------------------------------------------
      // Expand count / for_each
      // ------------------------------------------------------------------

      const rawCount = block["count"];
      const rawForEach = block["for_each"];

      if (rawCount !== undefined) {
        // count expansion
        const count = resolveCount(rawCount, baseId, warnings);
        for (let i = 0; i < count; i++) {
          resources.push({
            id: `${baseId}[${i}]`,
            type: resourceType,
            name: resourceName,
            provider,
            region,
            attributes,
            tags,
            source_file: sourceFile,
          });
        }
      } else if (rawForEach !== undefined) {
        // for_each expansion
        const keys = resolveForEachKeys(rawForEach, baseId, warnings);
        for (const key of keys) {
          resources.push({
            id: `${baseId}["${key}"]`,
            type: resourceType,
            name: resourceName,
            provider,
            region,
            attributes,
            tags,
            source_file: sourceFile,
          });
        }
      } else {
        // No expansion – single resource
        resources.push({
          id: baseId,
          type: resourceType,
          name: resourceName,
          provider,
          region,
          attributes,
          tags,
          source_file: sourceFile,
        });
      }

      logger.debug("Extracted resource", {
        id: baseId,
        region,
        provider,
      });
    }
  }

  return resources;
}
