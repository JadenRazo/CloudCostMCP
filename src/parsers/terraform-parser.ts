import type { IaCParser, FileInput, ParseOptions } from "./iac-parser.js";
import type { ResourceInventory } from "../types/resources.js";
import { parseTerraform } from "./index.js";

export class TerraformParser implements IaCParser {
  readonly name = "Terraform";
  readonly extensions = [".tf", ".tofu"] as const;

  detect(files: FileInput[]): boolean {
    return files.some(
      (f) =>
        this.extensions.some((ext) => f.path.endsWith(ext)) ||
        f.content.includes("resource ") ||
        f.content.includes("terraform {"),
    );
  }

  async parse(files: FileInput[], options?: ParseOptions): Promise<ResourceInventory> {
    return parseTerraform(
      files,
      options?.variableOverrides,
      options?.basePath,
      options?.resolveModules ?? true,
    );
  }
}
