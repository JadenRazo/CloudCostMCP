import { dirname, isAbsolute, normalize, sep } from "node:path";
import type { CloudProvider, ResourceInventory, ParsedResource } from "../types/index.js";
import { parseHclToJson } from "./hcl-parser.js";
import { resolveVariables } from "./variable-resolver.js";
import { extractResources, detectRegionFromProviders } from "./resource-extractor.js";
import { resolveModules, mergeHclJsons } from "./module-resolver.js";
import { logger } from "../logger.js";

export { parseHclToJson } from "./hcl-parser.js";
export { detectProvider } from "./provider-detector.js";
export { resolveVariables, substituteVariables } from "./variable-resolver.js";
export { extractResources, detectRegionFromProviders } from "./resource-extractor.js";
export { resolveModules, mergeHclJsons } from "./module-resolver.js";
export type { IaCParser, FileInput, ParseOptions } from "./iac-parser.js";
export { TerraformParser } from "./terraform-parser.js";
export { CloudFormationParser } from "./cloudformation/cfn-parser.js";
export { ArmParser } from "./bicep/arm-parser.js";
export { PulumiParser } from "./pulumi/pulumi-parser.js";
export { detectFormat, getParser, registerParser, listParsers } from "./format-detector.js";

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
 * Parse one or more Terraform or OpenTofu HCL files (and an optional .tfvars
 * override string) into a unified ResourceInventory. Both .tf and .tofu file
 * extensions use identical HCL syntax and are handled identically here.
 *
 * Processing steps:
 *  1. Parse each HCL file to JSON in parallel.
 *  2. Merge all parsed JSON objects to build a combined view of variables and
 *     provider blocks.
 *  3. Resolve variables (defaults + tfvars overrides).
 *  4. Detect the default region for each cloud provider from provider blocks.
 *  5. Extract resources from every file, applying the resolved variables.
 *  6. Optionally resolve module blocks and merge their resources.
 *  7. Build and return the ResourceInventory.
 *
 * @param files             Array of { path, content } pairs for each .tf file.
 * @param tfvarsContent     Optional raw contents of a .tfvars override file.
 * @param basePath          Absolute directory path used to resolve local module
 *                          sources. When omitted the directory of the first
 *                          file path is used as a best-effort fallback — but
 *                          only when that path is relative and does not escape
 *                          upward; untrusted absolute paths fall back to
 *                          process.cwd() (see deriveModuleBasePath).
 * @param resolveModulesEnabled  When true (default) module blocks are expanded.
 *                          Pass false to skip expansion and emit warnings only.
 */
export async function parseTerraform(
  files: { path: string; content: string }[],
  tfvarsContent?: string,
  basePath?: string,
  resolveModulesEnabled = true,
): Promise<ResourceInventory> {
  const warnings: string[] = [];
  const parsedJsons: Array<{ path: string; json: Record<string, unknown> }> = [];

  // Step 1: Parse all files
  for (const file of files) {
    try {
      const json = await parseHclToJson(file.content, file.path);
      parsedJsons.push({ path: file.path, json });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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

  // Step 6: Resolve module blocks when enabled
  if (resolveModulesEnabled) {
    // Determine the base directory for resolving relative module paths.
    // Use the explicit basePath if provided, otherwise derive it from the
    // first successfully parsed file path — but only when that path is
    // relative and stays inside the working directory. File paths arrive
    // from the MCP client and are otherwise untrusted: an absolute path
    // like "/etc/x.tf" combined with a module block would let a malicious
    // client direct the resolver to read *.tf files under arbitrary
    // host directories.
    const moduleBasePath =
      basePath ??
      (parsedJsons.length > 0 ? deriveModuleBasePath(parsedJsons[0].path) : process.cwd());

    try {
      const moduleResources = await resolveModules(combined, moduleBasePath, variables, warnings);
      allResources.push(...moduleResources);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Module resolution error: ${msg}`);
      logger.warn("Module resolution failed", { error: msg });
    }
  }

  // Step 7: Build inventory
  const dominantProvider = inferDominantProvider(allResources);
  const dominantRegion = defaultRegions[dominantProvider] ?? PROVIDER_DEFAULTS[dominantProvider];

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
// Module base-path derivation
// ---------------------------------------------------------------------------

/**
 * Derive a module-resolution base directory from a client-supplied file path.
 *
 * MCP clients control `files[].path` entirely, so the path is untrusted.
 * Only the dirname of a *relative* path (no leading separator, no Windows
 * drive letter or UNC prefix, and no `..` escape after normalisation) is
 * used; anything else falls back to `process.cwd()`, which is also the
 * boundary that `resolveModules` confines all module reads to.
 */
export function deriveModuleBasePath(filePath: string): string {
  const normalized = normalize(filePath);

  const isWindowsDrive = /^[A-Za-z]:/.test(normalized);
  const isWindowsUnc = normalized.startsWith("\\\\") || normalized.startsWith("//");
  if (isAbsolute(normalized) || isWindowsDrive || isWindowsUnc) {
    return process.cwd();
  }

  const dir = dirname(normalized);
  const escapesUpward = dir === ".." || dir.startsWith(`..${sep}`) || dir.startsWith("../");
  if (escapesUpward) {
    return process.cwd();
  }

  return dir;
}
