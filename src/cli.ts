/**
 * CloudCost MCP CLI
 *
 * NOTE: do not add a `#!/usr/bin/env node` line here. tsup injects one into
 * every bundle via `banner.js` in tsup.config.ts; a second copy in this source
 * file lands on line 2 of dist/cli.js, where Node does not strip it, and the
 * binary dies with `SyntaxError: Invalid or unexpected token`.
 *
 * Standalone command-line interface for the CloudCost MCP server tools.
 *
 * Usage:
 *   cloudcost analyze <path>
 *   cloudcost estimate <path> [--provider aws|azure|gcp] [--region <region>] [--currency <code>]
 *   cloudcost compare <path> [--format markdown|json|csv|focus] [--currency <code>]
 *   cloudcost optimize <path> [--providers aws,azure,gcp]
 *   cloudcost what-if <path> --changes <changes.json> [--provider aws|azure|gcp] [--region <region>]
 *
 * Flags:
 *   --json        Output raw JSON instead of formatted text
 *   --help, -h    Show usage
 */

import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "./currency.js";
import { PricingCache } from "./pricing/cache.js";
import { PricingEngine } from "./pricing/pricing-engine.js";
import { analyzeTerraform } from "./tools/analyze-terraform.js";
import { estimateCost } from "./tools/estimate-cost.js";
import { compareProviders } from "./tools/compare-providers.js";
import { optimizeCost } from "./tools/optimize-cost.js";
import { whatIf } from "./tools/what-if.js";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string | undefined;
  path: string | undefined;
  provider: string;
  region: string | undefined;
  format: string;
  providers: string[];
  currency: string;
  changes: string | undefined;
  json: boolean;
  help: boolean;
}

export const VALID_PROVIDERS = ["aws", "azure", "gcp"] as const;
export type ValidProvider = (typeof VALID_PROVIDERS)[number];

export const VALID_FORMATS = ["markdown", "json", "csv", "focus"] as const;
export type ValidFormat = (typeof VALID_FORMATS)[number];

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node + script path

  const parsed: ParsedArgs = {
    command: undefined,
    path: undefined,
    provider: "aws",
    region: undefined,
    format: "markdown",
    providers: ["aws", "azure", "gcp"],
    currency: "USD",
    changes: undefined,
    json: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--provider" && args[i + 1]) {
      parsed.provider = args[++i]!;
    } else if (arg === "--region" && args[i + 1]) {
      parsed.region = args[++i]!;
    } else if (arg === "--format" && args[i + 1]) {
      parsed.format = args[++i]!;
    } else if (arg === "--providers" && args[i + 1]) {
      parsed.providers = args[++i].split(",").map((p) => p.trim());
    } else if (arg === "--currency" && args[i + 1]) {
      parsed.currency = args[++i].toUpperCase();
    } else if (arg === "--changes" && args[i + 1]) {
      parsed.changes = args[++i]!;
    } else if (!arg.startsWith("--")) {
      if (!parsed.command) {
        parsed.command = arg;
      } else if (!parsed.path) {
        parsed.path = arg;
      }
    }

    i++;
  }

  return parsed;
}

/**
 * Validate option values after parsing. Returns a human-readable usage error
 * for the first invalid value, or null when everything is valid. Kept
 * separate from parseArgs so both are unit-testable without process.exit.
 */
export function validateArgs(args: ParsedArgs): string | null {
  if (!VALID_PROVIDERS.includes(args.provider as ValidProvider)) {
    return `Invalid --provider "${args.provider}". Must be one of: ${VALID_PROVIDERS.join(", ")}`;
  }
  if (!VALID_FORMATS.includes(args.format as ValidFormat)) {
    return `Invalid --format "${args.format}". Must be one of: ${VALID_FORMATS.join(", ")}`;
  }
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(args.currency)) {
    return `Invalid --currency "${args.currency}". Must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`;
  }
  for (const p of args.providers) {
    if (!VALID_PROVIDERS.includes(p as ValidProvider)) {
      return `Invalid provider "${p}" in --providers. Must be a comma-separated list of: ${VALID_PROVIDERS.join(", ")}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load Terraform files from a path (file or directory)
// ---------------------------------------------------------------------------

interface TfFile {
  path: string;
  content: string;
}

function loadTerraformFiles(inputPath: string): TfFile[] {
  const resolved = resolve(inputPath);

  if (!existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }

  const stat = statSync(resolved);

  if (stat.isFile()) {
    return [
      {
        path: resolved,
        content: readFileSync(resolved, "utf-8"),
      },
    ];
  }

  if (stat.isDirectory()) {
    const entries = readdirSync(resolved);
    const tfFiles = entries
      .filter((e) => extname(e) === ".tf" || extname(e) === ".tofu")
      .map((e) => join(resolved, e));

    if (tfFiles.length === 0) {
      throw new Error(`No .tf or .tofu files found in directory: ${resolved}`);
    }

    return tfFiles.map((f) => ({
      path: f,
      content: readFileSync(f, "utf-8"),
    }));
  }

  throw new Error(`Path is neither a file nor directory: ${resolved}`);
}

function loadTfvars(inputPath: string): string | undefined {
  const dir = statSync(resolve(inputPath)).isDirectory()
    ? resolve(inputPath)
    : resolve(inputPath, "..");

  const tfvarsPath = join(dir, "terraform.tfvars");
  if (existsSync(tfvarsPath)) {
    return readFileSync(tfvarsPath, "utf-8");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function printText(data: unknown): void {
  if (typeof data === "string") {
    process.stdout.write(data + "\n");
    return;
  }
  // For structured objects, pretty-print JSON
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(
    `
CloudCost — multi-cloud Terraform cost estimator

Usage:
  cloudcost analyze <path>                       Parse Terraform and show resource inventory
  cloudcost estimate <path> [options]            Estimate costs on a specific provider
  cloudcost compare <path> [options]             Compare costs across all providers
  cloudcost optimize <path> [options]            Show cost optimization recommendations
  cloudcost what-if <path> --changes <file>      Simulate attribute changes and show cost impact

Options:
  --provider <aws|azure|gcp>                     Target provider (default: aws)
  --region <region>                              Target region (default: auto-detect)
  --format <markdown|json|csv|focus>             Report format for compare (default: markdown)
  --providers <aws,azure,gcp>                    Comma-separated providers for compare/optimize
  --currency <USD|EUR|GBP|JPY|CAD|AUD|INR|BRL>   Output currency for estimate/compare (default: USD)
  --changes <path>                               JSON file with changes array for what-if
  --json                                         Output raw JSON
  --help, -h                                     Show this help

Examples:
  cloudcost analyze ./terraform
  cloudcost estimate ./terraform --provider aws --region us-east-1
  cloudcost compare ./terraform --format markdown
  cloudcost optimize ./terraform --providers aws,gcp
  cloudcost estimate main.tf --provider gcp --json
  cloudcost what-if ./terraform --changes changes.json --provider aws
`.trimStart(),
  );
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function runAnalyze(args: ParsedArgs, files: TfFile[], tfvars?: string): Promise<void> {
  const result = await analyzeTerraform({ files, tfvars, include_dependencies: false });

  if (args.json) {
    printJson(result);
  } else {
    printText(result);
  }
}

async function runEstimate(
  args: ParsedArgs,
  files: TfFile[],
  tfvars: string | undefined,
  pricingEngine: PricingEngine,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const result = await estimateCost(
    {
      files,
      tfvars,
      provider: args.provider as ValidProvider,
      region: args.region,
      currency: args.currency as SupportedCurrency,
    },
    pricingEngine,
    config,
  );

  if (args.json) {
    printJson(result);
  } else {
    printText(result);
  }
}

async function runCompare(
  args: ParsedArgs,
  files: TfFile[],
  tfvars: string | undefined,
  pricingEngine: PricingEngine,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const validatedProviders = args.providers.filter((p): p is ValidProvider =>
    VALID_PROVIDERS.includes(p as ValidProvider),
  );

  const result = await compareProviders(
    {
      files,
      tfvars,
      format: args.format as ValidFormat,
      currency: args.currency as SupportedCurrency,
      providers: validatedProviders.length > 0 ? validatedProviders : ["aws", "azure", "gcp"],
    },
    pricingEngine,
    config,
  );

  if (args.json) {
    printJson(result);
  } else {
    // compareProviders returns an object with a report string
    const obj = result as Record<string, unknown>;
    if (typeof obj["report"] === "string") {
      printText(obj["report"]);
    } else {
      printText(result);
    }
  }
}

async function runOptimize(
  args: ParsedArgs,
  files: TfFile[],
  tfvars: string | undefined,
  pricingEngine: PricingEngine,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const validatedProviders = args.providers.filter((p): p is ValidProvider =>
    VALID_PROVIDERS.includes(p as ValidProvider),
  );

  const result = await optimizeCost(
    {
      files,
      tfvars,
      providers: validatedProviders.length > 0 ? validatedProviders : ["aws", "azure", "gcp"],
    },
    pricingEngine,
    config,
  );

  if (args.json) {
    printJson(result);
  } else {
    printText(result);
  }
}

async function runWhatIf(
  args: ParsedArgs,
  files: TfFile[],
  tfvars: string | undefined,
  pricingEngine: PricingEngine,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!args.changes) {
    throw new Error(
      'The what-if command requires --changes <path> pointing to a JSON file with a "changes" array',
    );
  }

  const changesPath = resolve(args.changes);
  if (!existsSync(changesPath)) {
    throw new Error(`Changes file not found: ${changesPath}`);
  }

  let parsedChanges: unknown;
  try {
    parsedChanges = JSON.parse(readFileSync(changesPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse changes file "${changesPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Accept either a raw array or an object with a "changes" key.
  let changesArray: unknown;
  if (Array.isArray(parsedChanges)) {
    changesArray = parsedChanges;
  } else if (
    parsedChanges !== null &&
    typeof parsedChanges === "object" &&
    "changes" in parsedChanges &&
    Array.isArray((parsedChanges as Record<string, unknown>)["changes"])
  ) {
    changesArray = (parsedChanges as Record<string, unknown>)["changes"];
  } else {
    throw new Error(`Changes file must contain a JSON array or an object with a "changes" array`);
  }

  // Validate each change entry minimally before forwarding.
  const changes = (changesArray as unknown[]).map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`Change at index ${index} must be an object`);
    }
    const c = item as Record<string, unknown>;
    if (typeof c["resource_id"] !== "string" || !c["resource_id"]) {
      throw new Error(`Change at index ${index} is missing a valid "resource_id"`);
    }
    if (typeof c["attribute"] !== "string" || !c["attribute"]) {
      throw new Error(`Change at index ${index} is missing a valid "attribute"`);
    }
    if (typeof c["new_value"] !== "string" && typeof c["new_value"] !== "number") {
      throw new Error(`Change at index ${index} "new_value" must be a string or number`);
    }
    return {
      resource_id: c["resource_id"],
      attribute: c["attribute"],
      new_value: c["new_value"],
    };
  });

  const provider = VALID_PROVIDERS.includes(args.provider as ValidProvider)
    ? (args.provider as ValidProvider)
    : undefined;

  const result = await whatIf(
    {
      files,
      tfvars,
      changes,
      provider,
      region: args.region,
    },
    pricingEngine,
    config,
  );

  if (args.json) {
    printJson(result);
  } else {
    printText(result);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || !args.command) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const validCommands = ["analyze", "estimate", "compare", "optimize", "what-if"];
  if (!validCommands.includes(args.command)) {
    process.stderr.write(`Unknown command: ${args.command}\n`);
    printUsage();
    process.exit(1);
  }

  if (!args.path) {
    process.stderr.write(`Error: path argument is required\n`);
    printUsage();
    process.exit(1);
  }

  const argError = validateArgs(args);
  if (argError) {
    process.stderr.write(`Error: ${argError}\n\n`);
    printUsage();
    process.exit(1);
  }

  let files: TfFile[];
  let tfvars: string | undefined;

  try {
    files = loadTerraformFiles(args.path);
    tfvars = loadTfvars(args.path);
  } catch (err) {
    process.stderr.write(
      `Error loading Terraform files: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const config = loadConfig();
  const cache = new PricingCache(config.cache.db_path);
  const pricingEngine = new PricingEngine(cache, config);

  try {
    switch (args.command) {
      case "analyze":
        await runAnalyze(args, files, tfvars);
        break;
      case "estimate":
        await runEstimate(args, files, tfvars, pricingEngine, config);
        break;
      case "compare":
        await runCompare(args, files, tfvars, pricingEngine, config);
        break;
      case "optimize":
        await runOptimize(args, files, tfvars, pricingEngine, config);
        break;
      case "what-if":
        await runWhatIf(args, files, tfvars, pricingEngine, config);
        break;
    }
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    cache.close();
  }
}

/**
 * Only run the CLI when this file is the entry point. Guarding on the real
 * path (symlink-resolved, matching Node's ESM entry resolution for npm bin
 * shims) lets tests import parseArgs/validateArgs without triggering main().
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
