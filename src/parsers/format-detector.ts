import type { IaCParser, FileInput } from "./iac-parser.js";
import { TerraformParser } from "./terraform-parser.js";
import { CloudFormationParser } from "./cloudformation/cfn-parser.js";
import { ArmParser } from "./bicep/arm-parser.js";
import { PulumiParser } from "./pulumi/pulumi-parser.js";

/** Registry of available parsers, checked in order. ARM after CFn since both handle .json. */
const parsers: IaCParser[] = [
  new TerraformParser(),
  new CloudFormationParser(),
  new ArmParser(),
  new PulumiParser(),
];

/** Register a new parser (used when adding new IaC format support). */
export function registerParser(parser: IaCParser): void {
  parsers.push(parser);
}

/** Auto-detect the IaC format from file extensions and content. Returns the first matching parser, or null. */
export function detectFormat(files: FileInput[]): IaCParser | null {
  for (const parser of parsers) {
    if (parser.detect(files)) return parser;
  }
  return null;
}

/** Get a parser by name (case-insensitive). */
export function getParser(name: string): IaCParser | null {
  const lower = name.toLowerCase();
  return parsers.find((p) => p.name.toLowerCase() === lower) ?? null;
}

/** List all registered parser names. */
export function listParsers(): string[] {
  return parsers.map((p) => p.name);
}
