import YAML from "yaml";
import type { IaCParser, FileInput, ParseOptions } from "../iac-parser.js";
import type { ResourceInventory } from "../../types/resources.js";
import type { CloudFormationTemplate, CfnParameter } from "./cfn-types.js";
import { mapCfnResource } from "./cfn-resource-mapper.js";
import { logger } from "../../logger.js";
import type { ParsedResource } from "../../types/resources.js";

export class CloudFormationParser implements IaCParser {
  readonly name = "CloudFormation";
  readonly extensions = [".yaml", ".yml", ".json", ".template"] as const;

  detect(files: FileInput[]): boolean {
    return files.some((f) => {
      if (this.extensions.some((ext) => f.path.endsWith(ext))) {
        return f.content.includes("AWSTemplateFormatVersion") || f.content.includes("AWS::");
      }
      return false;
    });
  }

  async parse(files: FileInput[], options?: ParseOptions): Promise<ResourceInventory> {
    const warnings: string[] = [];

    // Parse the first CFn template file
    const file = files.find((f) => this.extensions.some((ext) => f.path.endsWith(ext)));
    if (!file) {
      return emptyInventory(warnings);
    }

    let template: CloudFormationTemplate;
    try {
      template = YAML.parse(file.content) as CloudFormationTemplate;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to parse CloudFormation template ${file.path}: ${msg}`);
      logger.warn("CloudFormation parse error", { path: file.path, error: msg });
      return emptyInventory(warnings);
    }

    if (!template || typeof template !== "object" || !template.Resources) {
      warnings.push(`Invalid CloudFormation template: missing Resources section in ${file.path}`);
      return emptyInventory(warnings);
    }

    // Resolve parameters: defaults first, then overrides
    const resolvedParams = resolveParameters(
      template.Parameters ?? {},
      options?.variableOverrides,
      warnings,
    );

    // Detect region from parameters or default
    const region = detectRegion(resolvedParams);

    // Map resources
    const resources: ParsedResource[] = [];
    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      const parsed = mapCfnResource(logicalId, resource, region, file.path, warnings);
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
      provider: "aws",
      region,
      resources,
      total_count: resources.length,
      by_type: byType,
      parse_warnings: warnings,
    };

    logger.info("CloudFormation parse complete", {
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
    provider: "aws",
    region: "us-east-1",
    resources: [],
    total_count: 0,
    by_type: {},
    parse_warnings: warnings,
  };
}

/**
 * Resolve CloudFormation parameters by applying defaults and overrides.
 * Overrides are provided as a JSON string of key-value pairs.
 */
function resolveParameters(
  parameters: Record<string, CfnParameter>,
  overridesJson: string | undefined,
  warnings: string[],
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  // Parse overrides
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
    } else if (param.Default !== undefined) {
      resolved[name] = param.Default;
    } else {
      warnings.push(`Parameter '${name}' has no default value and no override provided`);
    }
  }

  return resolved;
}

/**
 * Detect AWS region from resolved parameters. Looks for common parameter names
 * like "AWS::Region", "Region", or "AWSRegion". Falls back to us-east-1.
 */
function detectRegion(params: Record<string, unknown>): string {
  for (const key of ["AWS::Region", "Region", "AWSRegion", "region"]) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return "us-east-1";
}
