import type {
  ResourceInventory,
  ParsedResource,
  ResourceAttributes,
  CloudProvider,
} from "../../types/resources.js";
import type { TerraformState } from "./state-types.js";
import { str, num, bool } from "../extractors/helpers.js";
import { logger } from "../../logger.js";
import { safeJsonParse } from "../safe-json.js";
import { sanitizeForMessage } from "../../util/sanitize.js";

// ---------------------------------------------------------------------------
// Provider detection from the Terraform provider string
// ---------------------------------------------------------------------------

const PROVIDER_MAP: Record<string, CloudProvider> = {
  aws: "aws",
  azurerm: "azure",
  google: "gcp",
  "google-beta": "gcp",
};

/**
 * Extract the cloud provider from a Terraform provider address string.
 *
 * Examples:
 *   `provider["registry.terraform.io/hashicorp/aws"]` → "aws"
 *   `provider["registry.terraform.io/hashicorp/azurerm"]` → "azure"
 *   `provider["registry.terraform.io/hashicorp/google"]` → "gcp"
 */
function detectProviderFromString(providerAddr: string): CloudProvider | undefined {
  // The last segment of the registry path is the provider name
  const match = providerAddr.match(/\/([^"/]+)"\s*\]?\s*$/);
  if (match) {
    return PROVIDER_MAP[match[1]];
  }
  // Fallback: try matching known keys anywhere in the string
  for (const [key, value] of Object.entries(PROVIDER_MAP)) {
    if (providerAddr.includes(`/${key}"`) || providerAddr.includes(`/${key}]`)) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Region detection from instance attributes
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS: Record<CloudProvider, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
};

function detectRegion(attrs: Record<string, unknown>, provider: CloudProvider): string {
  switch (provider) {
    case "aws": {
      // availability_zone "us-east-1a" → "us-east-1"
      const az = str(attrs["availability_zone"]);
      if (az) return az.replace(/[a-z]$/, "");
      const region = str(attrs["region"]);
      if (region) return region;
      return PROVIDER_DEFAULTS.aws;
    }
    case "azure": {
      const location = str(attrs["location"]);
      if (location) return location;
      return PROVIDER_DEFAULTS.azure;
    }
    case "gcp": {
      // zone "us-central1-a" → "us-central1"
      const zone = str(attrs["zone"]);
      if (zone) {
        const parts = zone.split("-");
        return parts.length > 2 ? parts.slice(0, -1).join("-") : zone;
      }
      const region = str(attrs["region"]);
      if (region) return region;
      return PROVIDER_DEFAULTS.gcp;
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

/**
 * Extract cost-relevant attributes from the flat state instance attributes.
 * State attributes use the same keys the provider schema defines, so we map
 * them to the ResourceAttributes shape used by the cost engine.
 */
function extractAttributes(
  attrs: Record<string, unknown>,
  resourceType: string,
): ResourceAttributes {
  const result: ResourceAttributes = {};

  // Compute
  if (str(attrs["instance_type"])) result.instance_type = str(attrs["instance_type"]);
  if (str(attrs["instance_class"])) result.instance_type = str(attrs["instance_class"]);
  if (str(attrs["vm_size"])) result.vm_size = str(attrs["vm_size"]);
  if (str(attrs["machine_type"])) result.machine_type = str(attrs["machine_type"]);

  // Database
  if (str(attrs["engine"])) result.engine = str(attrs["engine"]);
  if (str(attrs["engine_version"])) result.engine_version = str(attrs["engine_version"]);
  if (attrs["multi_az"] !== undefined) result.multi_az = bool(attrs["multi_az"]);
  if (attrs["replicas"] !== undefined) result.replicas = num(attrs["replicas"]);

  // Storage
  if (str(attrs["storage_type"])) result.storage_type = str(attrs["storage_type"]);
  if (attrs["allocated_storage"] !== undefined)
    result.storage_size_gb = num(attrs["allocated_storage"]);
  if (attrs["size"] !== undefined && result.storage_size_gb === undefined)
    result.storage_size_gb = num(attrs["size"]);
  if (attrs["iops"] !== undefined) result.iops = num(attrs["iops"]);
  if (attrs["throughput"] !== undefined) result.throughput_mbps = num(attrs["throughput"]);

  // Tier / SKU
  if (str(attrs["tier"])) result.tier = str(attrs["tier"]);
  if (str(attrs["sku"])) result.sku = str(attrs["sku"]);
  if (str(attrs["sku_name"])) result.sku = str(attrs["sku_name"]);

  // Scaling
  if (attrs["node_count"] !== undefined) result.node_count = num(attrs["node_count"]);
  if (attrs["min_node_count"] !== undefined) result.min_node_count = num(attrs["min_node_count"]);
  if (attrs["max_node_count"] !== undefined) result.max_node_count = num(attrs["max_node_count"]);

  // OS
  if (str(attrs["os_type"])) result.os = str(attrs["os_type"]);

  // EBS / disk type from state "type" field (e.g. aws_ebs_volume has "type": "gp3")
  if (resourceType === "aws_ebs_volume" || resourceType === "aws_ebs_snapshot") {
    if (str(attrs["type"]) && !result.storage_type) result.storage_type = str(attrs["type"]);
  }

  // Load balancer
  if (str(attrs["load_balancer_type"]))
    result.load_balancer_type = str(attrs["load_balancer_type"]);
  if (attrs["internal"] !== undefined) result.internal = bool(attrs["internal"]);

  return result;
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

function extractTags(attrs: Record<string, unknown>): Record<string, string> {
  const tags = attrs["tags"];
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
    else if (v !== null && v !== undefined) result[k] = String(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Terraform `.tfstate` JSON string into a {@link ResourceInventory}.
 *
 * Only `managed` resources are included — data sources are skipped. Each
 * instance within a resource block (including count/for_each expansions)
 * becomes a separate {@link ParsedResource}.
 */
export function parseTerraformState(stateJson: string): ResourceInventory {
  const warnings: string[] = [];

  let state: TerraformState;
  try {
    state = safeJsonParse<TerraformState>(stateJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const safeMsg = sanitizeForMessage(msg, 512);
    logger.error("Failed to parse Terraform state JSON", { error: safeMsg });
    return {
      provider: "aws",
      region: PROVIDER_DEFAULTS.aws,
      resources: [],
      total_count: 0,
      by_type: {},
      parse_warnings: [`Invalid state JSON: ${safeMsg}`],
    };
  }

  if (!Array.isArray(state.resources)) {
    return {
      provider: "aws",
      region: PROVIDER_DEFAULTS.aws,
      resources: [],
      total_count: 0,
      by_type: {},
      parse_warnings: warnings,
    };
  }

  const allResources: ParsedResource[] = [];

  for (const block of state.resources) {
    // Skip data sources
    if (block.mode !== "managed") continue;

    const provider = detectProviderFromString(block.provider);
    if (!provider) {
      warnings.push(
        `Skipping resource "${block.type}.${block.name}": unknown provider "${block.provider}"`,
      );
      continue;
    }

    if (!Array.isArray(block.instances)) continue;

    for (const instance of block.instances) {
      const attrs = instance.attributes ?? {};
      const region = detectRegion(attrs, provider);
      const tags = extractTags(attrs);
      const attributes = extractAttributes(attrs, block.type);

      // Build resource ID: include index_key for count/for_each expansions
      let id = `${block.type}.${block.name}`;
      if (instance.index_key !== undefined) {
        id +=
          typeof instance.index_key === "number"
            ? `[${instance.index_key}]`
            : `["${instance.index_key}"]`;
      }

      allResources.push({
        id,
        type: block.type,
        name: block.name,
        provider,
        region,
        attributes,
        tags,
        source_file: "terraform.tfstate",
      });
    }
  }

  // Determine dominant provider and region
  const providerCounts: Partial<Record<CloudProvider, number>> = {};
  for (const r of allResources) {
    providerCounts[r.provider] = (providerCounts[r.provider] ?? 0) + 1;
  }

  let dominantProvider: CloudProvider = "aws";
  let maxCount = 0;
  for (const [p, c] of Object.entries(providerCounts) as [CloudProvider, number][]) {
    if (c > maxCount) {
      maxCount = c;
      dominantProvider = p;
    }
  }

  // Use the region of the first resource of the dominant provider, or the default
  const dominantRegion =
    allResources.find((r) => r.provider === dominantProvider)?.region ??
    PROVIDER_DEFAULTS[dominantProvider];

  const byType: Record<string, number> = {};
  for (const r of allResources) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }

  logger.info("Terraform state parse complete", {
    resourceCount: allResources.length,
    provider: dominantProvider,
    region: dominantRegion,
    warningCount: warnings.length,
  });

  return {
    provider: dominantProvider,
    region: dominantRegion,
    resources: allResources,
    total_count: allResources.length,
    by_type: byType,
    parse_warnings: warnings,
  };
}
