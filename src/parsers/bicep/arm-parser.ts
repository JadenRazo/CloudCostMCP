import type { IaCParser, FileInput, ParseOptions } from "../iac-parser.js";
import type { ResourceInventory, ParsedResource } from "../../types/resources.js";
import type { ArmTemplate } from "./arm-types.js";
import { mapArmResource } from "./arm-resource-mapper.js";
import { logger } from "../../logger.js";

export class ArmParser implements IaCParser {
  readonly name = "ARM";
  readonly extensions = [".json"] as const;

  detect(files: FileInput[]): boolean {
    return files.some((f) => {
      if (!f.path.endsWith(".json")) return false;
      return (
        f.content.includes("schema.management.azure.com") ||
        (f.content.includes("Microsoft.") && f.content.includes("apiVersion"))
      );
    });
  }

  async parse(files: FileInput[], options?: ParseOptions): Promise<ResourceInventory> {
    const warnings: string[] = [];

    const file = files.find((f) => f.path.endsWith(".json"));
    if (!file) {
      return emptyInventory(warnings);
    }

    let template: ArmTemplate;
    try {
      template = JSON.parse(file.content) as ArmTemplate;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to parse ARM template ${file.path}: ${msg}`);
      logger.warn("ARM template parse error", { path: file.path, error: msg });
      return emptyInventory(warnings);
    }

    if (!template || typeof template !== "object" || !Array.isArray(template.resources)) {
      warnings.push(`Invalid ARM template: missing resources array in ${file.path}`);
      return emptyInventory(warnings);
    }

    // Resolve parameters: defaults first, then overrides
    const resolvedParams = resolveParameters(
      template.parameters ?? {},
      options?.variableOverrides,
      warnings,
    );

    // Detect region from parameters or resource locations
    const region = detectRegion(resolvedParams, template.resources);

    // Map resources
    const resources: ParsedResource[] = [];
    for (const armResource of template.resources) {
      const parsed = mapArmResource(armResource, region, resolvedParams, file.path, warnings);
      if (parsed) {
        resources.push(parsed);
      }
    }

    // Build by_type counts
    const byType: Record<string, number> = {};
    for (const r of resources) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
    }

    const inventory: ResourceInventory = {
      provider: "azure",
      region,
      resources,
      total_count: resources.length,
      by_type: byType,
      parse_warnings: warnings,
    };

    logger.info("ARM template parse complete", {
      path: file.path,
      resourceCount: resources.length,
      region,
      warningCount: warnings.length,
    });

    return inventory;
  }
}

function emptyInventory(warnings: string[]): ResourceInventory {
  return {
    provider: "azure",
    region: "eastus",
    resources: [],
    total_count: 0,
    by_type: {},
    parse_warnings: warnings,
  };
}

/**
 * Resolve ARM template parameters by applying defaults and overrides.
 * Overrides are provided as a JSON string of key-value pairs.
 */
function resolveParameters(
  parameters: Record<string, { type: string; defaultValue?: unknown }>,
  overridesJson: string | undefined,
  warnings: string[],
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  let overrides: Record<string, unknown> = {};
  if (overridesJson) {
    try {
      overrides = JSON.parse(overridesJson) as Record<string, unknown>;
    } catch {
      warnings.push("Failed to parse parameter overrides as JSON");
    }
  }

  for (const [name, param] of Object.entries(parameters)) {
    if (name in overrides) {
      resolved[name] = overrides[name];
    } else if (param.defaultValue !== undefined) {
      resolved[name] = param.defaultValue;
    } else {
      warnings.push(`Parameter '${name}' has no default value and no override provided`);
    }
  }

  return resolved;
}

/**
 * Detect Azure region from resolved parameters or resource locations.
 * Falls back to "eastus".
 */
function detectRegion(
  params: Record<string, unknown>,
  resources: Array<{ location?: string }>,
): string {
  // Check common parameter names
  for (const key of ["location", "Location", "region", "Region"]) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0 && !val.startsWith("[")) {
      return val;
    }
  }

  // Check first resource with a concrete location
  for (const r of resources) {
    if (typeof r.location === "string" && r.location.length > 0 && !r.location.startsWith("[")) {
      return r.location;
    }
  }

  return "eastus";
}
