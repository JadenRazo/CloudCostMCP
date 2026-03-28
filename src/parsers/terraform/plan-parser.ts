import type {
  ResourceInventory,
  ParsedResource,
  ResourceAttributes,
  CloudProvider,
} from "../../types/resources.js";
import type { TerraformPlan, ResourceChange } from "./plan-types.js";
import { logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlanAnalysis {
  before: ResourceInventory;
  after: ResourceInventory;
  changes: PlanResourceChange[];
  summary: {
    creates: number;
    updates: number;
    deletes: number;
    no_ops: number;
    replaces: number;
  };
}

export interface PlanResourceChange {
  address: string;
  type: string;
  action: "create" | "update" | "delete" | "replace" | "no-op";
  before_attributes: Record<string, unknown> | null;
  after_attributes: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Provider detection from provider_name
// ---------------------------------------------------------------------------

const PROVIDER_MAP: Record<string, CloudProvider> = {
  aws: "aws",
  azurerm: "azure",
  google: "gcp",
};

function detectProviderFromName(providerName: string): CloudProvider {
  // provider_name looks like "registry.terraform.io/hashicorp/aws"
  const segments = providerName.split("/");
  const shortName = segments[segments.length - 1];
  return PROVIDER_MAP[shortName] ?? "aws";
}

// ---------------------------------------------------------------------------
// Region detection from resource attributes
// ---------------------------------------------------------------------------

const DEFAULT_REGIONS: Record<CloudProvider, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
};

function detectRegion(attrs: Record<string, unknown> | null, provider: CloudProvider): string {
  if (!attrs) return DEFAULT_REGIONS[provider];

  // AWS: check availability_zone, strip the trailing letter to get region
  if (provider === "aws") {
    const az = typeof attrs["availability_zone"] === "string" ? attrs["availability_zone"] : null;
    if (az) {
      // e.g. "us-east-1a" -> "us-east-1"
      return az.replace(/[a-z]$/, "");
    }
    const region = typeof attrs["region"] === "string" ? attrs["region"] : null;
    if (region) return region;
  }

  // Azure: check location
  if (provider === "azure") {
    const loc = typeof attrs["location"] === "string" ? attrs["location"] : null;
    if (loc) return loc;
  }

  // GCP: check zone (strip suffix) or region
  if (provider === "gcp") {
    const zone = typeof attrs["zone"] === "string" ? attrs["zone"] : null;
    if (zone) {
      const parts = zone.split("-");
      return parts.length > 2 ? parts.slice(0, -1).join("-") : zone;
    }
    const region = typeof attrs["region"] === "string" ? attrs["region"] : null;
    if (region) return region;
  }

  return DEFAULT_REGIONS[provider];
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

/** Keys that map directly to ResourceAttributes from plan JSON values. */
const ATTRIBUTE_KEYS: readonly string[] = [
  "instance_type",
  "vm_size",
  "machine_type",
  "engine",
  "engine_version",
  "storage_type",
  "iops",
  "throughput_mbps",
  "multi_az",
  "replicas",
  "node_count",
  "min_node_count",
  "max_node_count",
  "os",
  "tier",
  "sku",
] as const;

/** Alternate keys for storage size that vary across providers. */
const STORAGE_SIZE_KEYS = ["size", "storage_size_gb", "disk_size_gb", "max_size_gb"];

function extractAttributes(attrs: Record<string, unknown>): ResourceAttributes {
  const result: ResourceAttributes = {};

  for (const key of ATTRIBUTE_KEYS) {
    if (attrs[key] !== undefined && attrs[key] !== null) {
      (result as Record<string, unknown>)[key] = attrs[key];
    }
  }

  // Normalise storage size into storage_size_gb
  for (const key of STORAGE_SIZE_KEYS) {
    const val = attrs[key];
    if (typeof val === "number" && val > 0) {
      result.storage_size_gb = val;
      break;
    }
  }

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
    result[k] = String(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build ParsedResource from plan attributes
// ---------------------------------------------------------------------------

function buildResource(
  rc: ResourceChange,
  attrs: Record<string, unknown>,
  provider: CloudProvider,
  region: string,
): ParsedResource {
  return {
    id: rc.address,
    type: rc.type,
    name: rc.name,
    provider,
    region,
    attributes: extractAttributes(attrs),
    tags: extractTags(attrs),
    source_file: "plan.json",
  };
}

// ---------------------------------------------------------------------------
// Classify the action for a resource change
// ---------------------------------------------------------------------------

function classifyAction(actions: string[]): "create" | "update" | "delete" | "replace" | "no-op" {
  if (actions.length === 2) {
    // ["create","delete"] or ["delete","create"] both mean replace
    if (actions.includes("create") && actions.includes("delete")) {
      return "replace";
    }
  }
  if (actions.length === 1) {
    const a = actions[0];
    if (a === "create") return "create";
    if (a === "delete") return "delete";
    if (a === "update") return "update";
    if (a === "no-op") return "no-op";
    if (a === "read") return "no-op";
  }
  return "no-op";
}

// ---------------------------------------------------------------------------
// Build inventory helper
// ---------------------------------------------------------------------------

function buildInventory(resources: ParsedResource[], warnings: string[]): ResourceInventory {
  const byType: Record<string, number> = {};
  for (const r of resources) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }

  // Infer dominant provider
  const providerCounts: Partial<Record<CloudProvider, number>> = {};
  for (const r of resources) {
    providerCounts[r.provider] = (providerCounts[r.provider] ?? 0) + 1;
  }
  let dominant: CloudProvider = "aws";
  let max = 0;
  for (const [p, c] of Object.entries(providerCounts) as [CloudProvider, number][]) {
    if (c > max) {
      max = c;
      dominant = p;
    }
  }

  // Pick the region from the first resource of the dominant provider,
  // falling back to the default.
  const dominantResource = resources.find((r) => r.provider === dominant);
  const region = dominantResource?.region ?? DEFAULT_REGIONS[dominant];

  return {
    provider: dominant,
    region,
    resources,
    total_count: resources.length,
    by_type: byType,
    parse_warnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse the JSON output of `terraform show -json <planfile>` (or
 * `terraform plan -json`) into a PlanAnalysis with before/after
 * ResourceInventory values and a change summary.
 */
export function parseTerraformPlan(planJson: string): PlanAnalysis {
  let plan: TerraformPlan;
  try {
    plan = JSON.parse(planJson) as TerraformPlan;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid plan JSON: ${msg}`);
  }

  if (!Array.isArray(plan.resource_changes)) {
    throw new Error("Invalid plan JSON: missing or non-array resource_changes field");
  }

  const beforeResources: ParsedResource[] = [];
  const afterResources: ParsedResource[] = [];
  const changes: PlanResourceChange[] = [];
  const warnings: string[] = [];

  const summary = {
    creates: 0,
    updates: 0,
    deletes: 0,
    no_ops: 0,
    replaces: 0,
  };

  for (const rc of plan.resource_changes) {
    const provider = detectProviderFromName(rc.provider_name);
    const action = classifyAction(rc.change.actions);

    // Determine region from whichever side is non-null, preferring after
    const region =
      detectRegion(rc.change.after, provider) || detectRegion(rc.change.before, provider);

    // Build before resource if there are before attributes (existing infra)
    if (rc.change.before) {
      beforeResources.push(buildResource(rc, rc.change.before, provider, region));
    }

    // Build after resource if there are after attributes (planned infra)
    if (rc.change.after) {
      afterResources.push(buildResource(rc, rc.change.after, provider, region));
    }

    changes.push({
      address: rc.address,
      type: rc.type,
      action,
      before_attributes: rc.change.before,
      after_attributes: rc.change.after,
    });

    switch (action) {
      case "create":
        summary.creates++;
        break;
      case "update":
        summary.updates++;
        break;
      case "delete":
        summary.deletes++;
        break;
      case "replace":
        summary.replaces++;
        break;
      case "no-op":
        summary.no_ops++;
        break;
    }
  }

  logger.debug("parseTerraformPlan complete", {
    resourceChanges: plan.resource_changes.length,
    summary,
  });

  return {
    before: buildInventory(beforeResources, warnings),
    after: buildInventory(afterResources, warnings),
    changes,
    summary,
  };
}
