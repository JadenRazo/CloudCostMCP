import type { ResourceInventory } from "../types/resources.js";

/** Standard file input for all IaC parsers. */
export interface FileInput {
  path: string;
  content: string;
}

/** Options shared across all IaC parsers. */
export interface ParseOptions {
  /** Optional variable overrides (terraform.tfvars content, CFn parameters, etc.) */
  variableOverrides?: string;
  /** Base path for resolving relative module/template references */
  basePath?: string;
  /** Whether to resolve module/nested stack references (default: true) */
  resolveModules?: boolean;
}

/** All IaC parsers produce a ResourceInventory. */
export interface IaCParser {
  /** Human-readable name (e.g. "Terraform", "CloudFormation") */
  readonly name: string;
  /** File extensions this parser handles */
  readonly extensions: readonly string[];
  /** Check if this parser can handle the given files based on extension or content */
  detect(files: FileInput[]): boolean;
  /** Parse the files into a ResourceInventory */
  parse(files: FileInput[], options?: ParseOptions): Promise<ResourceInventory>;
}
