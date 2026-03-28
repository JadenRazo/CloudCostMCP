import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedResource, CloudProvider } from "../types/index.js";
import { parseHclToJson } from "./hcl-parser.js";
import { resolveVariables, substituteVariables } from "./variable-resolver.js";
import { extractResources, detectRegionFromProviders } from "./resource-extractor.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MODULE_DEPTH = 10;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect all .tf files from a directory (non-recursive — Terraform module
 * directories are flat by convention; submodules have their own source paths).
 */
function readTfFiles(dirPath: string): Array<{ path: string; content: string }> {
  if (!existsSync(dirPath)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return [];
  }

  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".tf")) continue;
    const fullPath = join(dirPath, entry);
    try {
      const content = readFileSync(fullPath, "utf-8");
      files.push({ path: fullPath, content });
    } catch {
      // Silently skip files that cannot be read — callers handle warnings.
    }
  }

  return files;
}

/**
 * Merge multiple HCL JSON objects into one so that variable and provider
 * blocks from separate .tf files are combined. Duplicate keys at the top level
 * are merged recursively; arrays are concatenated.
 */
function mergeHclJsons(jsons: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const json of jsons) {
    for (const [key, value] of Object.entries(json)) {
      if (!(key in merged)) {
        merged[key] = JSON.parse(JSON.stringify(value));
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
        merged[key] = mergeObjects(
          existing as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else if (Array.isArray(existing) && Array.isArray(value)) {
        merged[key] = [...existing, ...value];
      } else {
        merged[key] = JSON.parse(JSON.stringify(value));
      }
    }
  }

  return merged;
}

function mergeObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
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
      result[key] = mergeObjects(aVal as Record<string, unknown>, bVal as Record<string, unknown>);
    } else if (Array.isArray(aVal) && Array.isArray(bVal)) {
      result[key] = [...aVal, ...bVal];
    } else {
      result[key] = JSON.parse(JSON.stringify(bVal));
    }
  }
  return result;
}

/**
 * Extract the first string value from a HCL JSON block array for an attribute.
 * HCL JSON wraps block attributes as arrays of objects; the source attribute
 * lives inside `module.<name>[0].source`.
 */
function getSourceAttr(moduleDeclaration: unknown): string | undefined {
  if (!Array.isArray(moduleDeclaration) || moduleDeclaration.length === 0) {
    return undefined;
  }
  const block = moduleDeclaration[0];
  if (!block || typeof block !== "object") return undefined;
  const source = (block as Record<string, unknown>)["source"];
  return typeof source === "string" ? source : undefined;
}

/**
 * Extract all scalar/non-source attributes from the first block of a module
 * declaration to use as input variable overrides for the child module.
 */
function extractModuleInputs(moduleDeclaration: unknown): Record<string, unknown> {
  if (!Array.isArray(moduleDeclaration) || moduleDeclaration.length === 0) {
    return {};
  }
  const block = moduleDeclaration[0];
  if (!block || typeof block !== "object") return {};

  const inputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    // Skip meta-attributes that are not variable inputs
    if (
      key === "source" ||
      key === "version" ||
      key === "providers" ||
      key === "depends_on" ||
      key === "count" ||
      key === "for_each"
    ) {
      continue;
    }
    inputs[key] = value;
  }
  return inputs;
}

/**
 * Prefix every resource id in the list with `module.<moduleName>.` so that
 * module resources are distinguishable from root resources in the inventory.
 */
function prefixResources(resources: ParsedResource[], moduleName: string): ParsedResource[] {
  return resources.map((r) => ({
    ...r,
    id: `module.${moduleName}.${r.id}`,
  }));
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Parse all .tf files in a directory, expand any nested module blocks found
 * within them (up to maxDepth), and return the collected ParsedResource array.
 *
 * @param dirPath      Absolute filesystem path to the module directory.
 * @param parentVars   Variables resolved in the parent scope (used to resolve
 *                     variable references passed into this module).
 * @param moduleInputs Attribute values passed from the parent module block
 *                     (act as variable overrides for the child module).
 * @param warnings     Shared warnings array written to by every level.
 * @param depth        Current recursion depth; aborted when >= MAX_MODULE_DEPTH.
 */
async function parseModuleDirectory(
  dirPath: string,
  parentVars: Record<string, unknown>,
  moduleInputs: Record<string, unknown>,
  warnings: string[],
  depth: number,
): Promise<ParsedResource[]> {
  if (depth >= MAX_MODULE_DEPTH) {
    warnings.push(
      `Module nesting depth limit (${MAX_MODULE_DEPTH}) reached at "${dirPath}". Skipping further expansion.`,
    );
    return [];
  }

  const tfFiles = readTfFiles(dirPath);
  if (tfFiles.length === 0) {
    return [];
  }

  const parsedJsons: Array<{ path: string; json: Record<string, unknown> }> = [];

  for (const file of tfFiles) {
    try {
      const json = await parseHclToJson(file.content, file.path);
      parsedJsons.push({ path: file.path, json });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Parse error in module file ${file.path}: ${msg}`);
      logger.warn("Skipping module file due to parse error", {
        path: file.path,
        error: msg,
      });
    }
  }

  if (parsedJsons.length === 0) return [];

  const combined = mergeHclJsons(parsedJsons.map((p) => p.json));

  // Resolve variables: child defaults first, then parent inputs override them.
  const childDefaults = resolveVariables(combined);
  const variables: Record<string, unknown> = {
    ...childDefaults,
    ...moduleInputs,
  };

  const providers: CloudProvider[] = ["aws", "azure", "gcp"];
  const defaultRegions: Partial<Record<CloudProvider, string>> = {};
  for (const p of providers) {
    defaultRegions[p] = detectRegionFromProviders(combined, p, variables);
  }

  const allResources: ParsedResource[] = [];

  for (const { path, json } of parsedJsons) {
    try {
      const resources = extractResources(json, variables, path, defaultRegions, warnings);
      allResources.push(...resources);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Extraction error in module file ${path}: ${msg}`);
      logger.warn("Resource extraction failed in module", { path, error: msg });
    }
  }

  // Recursively expand any nested module blocks found in this module directory.
  const nestedResources = await resolveModules(combined, dirPath, variables, warnings, depth + 1);
  allResources.push(...nestedResources);

  return allResources;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk the `module` blocks in the provided HCL JSON and attempt to resolve
 * each one's resources.
 *
 * - **Local modules** (source starts with `./` or `../`): resolved relative
 *   to `basePath` by reading and parsing all .tf files in that directory.
 * - **Registry modules** (source like `terraform-aws-modules/vpc/aws`):
 *   looked up under `<basePath>/.terraform/modules/<moduleName>/`. Requires
 *   `terraform init` to have been run. A warning is emitted and the module is
 *   skipped when the directory does not exist.
 * - **Git modules** (source starts with `git::` or contains `github.com`):
 *   not supported; a warning is emitted and the module is skipped.
 *
 * Resources returned from child modules have their IDs prefixed with
 * `module.<name>.` (nested modules accumulate multiple prefixes).
 *
 * @param hclJson    Parsed HCL JSON that may contain a top-level `module` block.
 * @param basePath   Absolute path to the directory containing the root .tf files.
 * @param variables  Already-resolved variables from the current scope.
 * @param warnings   Mutable array to which diagnostic messages are appended.
 * @param depth      Internal recursion counter; callers should omit this.
 */
export async function resolveModules(
  hclJson: Record<string, unknown>,
  basePath: string,
  variables: Record<string, unknown>,
  warnings: string[],
  depth = 0,
): Promise<ParsedResource[]> {
  const moduleBlock = hclJson["module"];
  if (!moduleBlock || typeof moduleBlock !== "object" || Array.isArray(moduleBlock)) {
    return [];
  }

  const allResources: ParsedResource[] = [];

  for (const [moduleName, moduleDeclaration] of Object.entries(
    moduleBlock as Record<string, unknown>,
  )) {
    const source = getSourceAttr(moduleDeclaration);
    if (!source) {
      warnings.push(`Module "${moduleName}" has no source attribute and will be skipped.`);
      continue;
    }

    // ------------------------------------------------------------------
    // Classify the source
    // ------------------------------------------------------------------

    const isLocal = source.startsWith("./") || source.startsWith("../");
    const isGit =
      source.startsWith("git::") ||
      source.includes("github.com") ||
      source.includes("bitbucket.org") ||
      source.startsWith("hg::");

    if (isGit) {
      warnings.push(
        `Module "${moduleName}" uses a git source ("${source}") which is not supported. Skipping.`,
      );
      logger.debug("Skipping git module", { moduleName, source });
      continue;
    }

    // Extract module inputs and substitute parent-scope variables so that
    // expressions like `instance_type = var.child_instance_type` are resolved
    // before being passed as overrides into the child module.
    const rawInputs = extractModuleInputs(moduleDeclaration);
    const moduleInputs = substituteVariables(rawInputs, variables) as Record<string, unknown>;

    let moduleDir: string;

    if (isLocal) {
      // Local path: resolve relative to the current basePath
      moduleDir = resolve(basePath, source);
    } else {
      // Registry module: look for the pre-downloaded copy under .terraform/modules/
      // Terraform populates this after `terraform init`.
      const terraformModulesDir = join(basePath, ".terraform", "modules");
      // Try direct name match first, then fall back to scanning for a directory
      // that contains the module (Terraform uses <name> or <name>.<hash>).
      const candidateDirect = join(terraformModulesDir, moduleName);
      if (existsSync(candidateDirect)) {
        moduleDir = candidateDirect;
      } else {
        // Terraform sometimes nests registry modules further. Check modules.json
        // for the exact path mapping if it exists.
        const modulesJsonPath = join(terraformModulesDir, "modules.json");
        if (existsSync(modulesJsonPath)) {
          try {
            const modulesJson = JSON.parse(readFileSync(modulesJsonPath, "utf-8")) as {
              Modules?: Array<{ Key: string; Dir: string }>;
            };
            const entry = modulesJson.Modules?.find(
              (m) => m.Key === moduleName || m.Key.startsWith(`${moduleName}.`),
            );
            if (entry?.Dir) {
              moduleDir = resolve(basePath, entry.Dir);
            } else {
              warnings.push(
                `Registry module "${moduleName}" (source: "${source}") not found in .terraform/modules/. ` +
                  `Run "terraform init" to download modules before estimating costs.`,
              );
              logger.debug("Registry module not initialised", { moduleName, source });
              continue;
            }
          } catch {
            warnings.push(
              `Registry module "${moduleName}" (source: "${source}") not found in .terraform/modules/. ` +
                `Run "terraform init" to download modules before estimating costs.`,
            );
            continue;
          }
        } else {
          warnings.push(
            `Registry module "${moduleName}" (source: "${source}") not found in .terraform/modules/. ` +
              `Run "terraform init" to download modules before estimating costs.`,
          );
          logger.debug("Registry module not initialised", { moduleName, source });
          continue;
        }
      }
    }

    logger.debug("Resolving module", { moduleName, source, moduleDir, depth });

    const childResources = await parseModuleDirectory(
      moduleDir,
      variables,
      moduleInputs,
      warnings,
      depth,
    );

    allResources.push(...prefixResources(childResources, moduleName));
  }

  return allResources;
}
