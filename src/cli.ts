#!/usr/bin/env node
/**
 * CloudCost MCP CLI
 *
 * Standalone command-line interface for the CloudCost MCP server tools.
 *
 * Usage:
 *   cloudcost analyze <path>
 *   cloudcost estimate <path> [--provider aws|azure|gcp] [--region <region>]
 *   cloudcost compare <path> [--format markdown|json|csv]
 *   cloudcost optimize <path> [--providers aws,azure,gcp]
 *
 * Flags:
 *   --json        Output raw JSON instead of formatted text
 *   --help, -h    Show usage
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { readdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { PricingCache } from "./pricing/cache.js";
import { PricingEngine } from "./pricing/pricing-engine.js";
import { analyzeTerraform } from "./tools/analyze-terraform.js";
import { estimateCost } from "./tools/estimate-cost.js";
import { compareProviders } from "./tools/compare-providers.js";
import { optimizeCost } from "./tools/optimize-cost.js";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string | undefined;
  path: string | undefined;
  provider: string;
  region: string | undefined;
  format: string;
  providers: string[];
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node + script path

  const parsed: ParsedArgs = {
    command: undefined,
    path: undefined,
    provider: "aws",
    region: undefined,
    format: "markdown",
    providers: ["aws", "azure", "gcp"],
    json: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

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
      parsed.providers = args[++i]!.split(",").map((p) => p.trim());
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
  process.stdout.write(`
CloudCost — multi-cloud Terraform cost estimator

Usage:
  cloudcost analyze <path>                       Parse Terraform and show resource inventory
  cloudcost estimate <path> [options]            Estimate costs on a specific provider
  cloudcost compare <path> [options]             Compare costs across all providers
  cloudcost optimize <path> [options]            Show cost optimization recommendations

Options:
  --provider <aws|azure|gcp>                     Target provider (default: aws)
  --region <region>                              Target region (default: auto-detect)
  --format <markdown|json|csv>                   Report format for compare (default: markdown)
  --providers <aws,azure,gcp>                    Comma-separated providers for compare/optimize
  --json                                         Output raw JSON
  --help, -h                                     Show this help

Examples:
  cloudcost analyze ./terraform
  cloudcost estimate ./terraform --provider aws --region us-east-1
  cloudcost compare ./terraform --format markdown
  cloudcost optimize ./terraform --providers aws,gcp
  cloudcost estimate main.tf --provider gcp --json
`.trimStart());
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function runAnalyze(args: ParsedArgs, files: TfFile[], tfvars?: string): Promise<void> {
  const result = await analyzeTerraform({ files, tfvars });

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
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  const validProviders = ["aws", "azure", "gcp"] as const;
  type ValidProvider = typeof validProviders[number];

  if (!validProviders.includes(args.provider as ValidProvider)) {
    throw new Error(`Invalid provider "${args.provider}". Must be one of: aws, azure, gcp`);
  }

  const result = await estimateCost(
    {
      files,
      tfvars,
      provider: args.provider as ValidProvider,
      region: args.region,
      currency: "USD",
    },
    pricingEngine,
    config
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
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  const validFormats = ["markdown", "json", "csv"] as const;
  type ValidFormat = typeof validFormats[number];
  type ValidProvider = "aws" | "azure" | "gcp";

  if (!validFormats.includes(args.format as ValidFormat)) {
    throw new Error(`Invalid format "${args.format}". Must be one of: markdown, json, csv`);
  }

  const validatedProviders = args.providers.filter((p): p is ValidProvider =>
    p === "aws" || p === "azure" || p === "gcp"
  );

  const result = await compareProviders(
    {
      files,
      tfvars,
      format: args.format as ValidFormat,
      currency: "USD",
      providers: validatedProviders.length > 0
        ? validatedProviders
        : ["aws", "azure", "gcp"],
    },
    pricingEngine,
    config
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
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  type ValidProvider = "aws" | "azure" | "gcp";

  const validatedProviders = args.providers.filter((p): p is ValidProvider =>
    p === "aws" || p === "azure" || p === "gcp"
  );

  const result = await optimizeCost(
    {
      files,
      tfvars,
      providers: validatedProviders.length > 0
        ? validatedProviders
        : ["aws", "azure", "gcp"],
    },
    pricingEngine,
    config
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

  const validCommands = ["analyze", "estimate", "compare", "optimize"];
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

  let files: TfFile[];
  let tfvars: string | undefined;

  try {
    files = loadTerraformFiles(args.path);
    tfvars = loadTfvars(args.path);
  } catch (err) {
    process.stderr.write(`Error loading Terraform files: ${err instanceof Error ? err.message : String(err)}\n`);
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
    }
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    cache.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
