import { z } from "zod";
import { parseTerraform } from "../parsers/index.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const analyzeTerraformSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().describe("File path"),
        content: z.string().describe("File content (HCL)"),
      })
    )
    .describe("Terraform files to analyze"),
  tfvars: z
    .string()
    .optional()
    .describe("Contents of terraform.tfvars file"),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Parse one or more Terraform HCL files and return the resulting
 * ResourceInventory as a plain object suitable for JSON serialisation.
 *
 * parse_warnings is promoted to the top of the response so callers can
 * immediately identify resources that could not be fully resolved (e.g.
 * module blocks not expanded, count/for_each unresolved).
 */
export async function analyzeTerraform(
  params: z.infer<typeof analyzeTerraformSchema>
): Promise<object> {
  const inventory = await parseTerraform(params.files, params.tfvars);

  // Reorder so parse_warnings appears first in serialised output for
  // immediate visibility to callers inspecting the raw JSON.
  const { parse_warnings, ...rest } = inventory;

  return {
    parse_warnings,
    has_warnings: parse_warnings.length > 0,
    ...rest,
  } as unknown as object;
}
