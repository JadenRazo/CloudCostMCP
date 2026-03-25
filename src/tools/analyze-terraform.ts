import { z } from "zod";
import { parseTerraform, parseHclToJson } from "../parsers/index.js";
import {
  buildDependencyGraph,
  generateMermaidDiagram,
} from "../parsers/dependency-graph.js";

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
  include_dependencies: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, parse resource references and depends_on blocks to build a dependency graph and Mermaid diagram"
    ),
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
  const { parse_warnings, resources, ...rest } = inventory;

  // Strip empty tags objects from each resource to reduce payload size.
  // If all resources share the same source_file, hoist it to the top level
  // and drop it from individual resources.
  const sourceFiles = new Set(resources.map((r) => r.source_file).filter(Boolean));
  const sharedSourceFile = sourceFiles.size === 1 ? [...sourceFiles][0] : undefined;

  const trimmedResources = resources.map((r) => {
    const trimmed: Record<string, unknown> = { ...r };
    if (trimmed.tags && typeof trimmed.tags === "object" && Object.keys(trimmed.tags as object).length === 0) {
      delete trimmed.tags;
    }
    if (sharedSourceFile) {
      delete trimmed.source_file;
      delete trimmed.source_line;
    }
    return trimmed;
  });

  const response: Record<string, unknown> = {
    parse_warnings,
    ...(sharedSourceFile ? { source_file: sharedSourceFile } : {}),
    resources: trimmedResources,
    ...rest,
  };

  if (params.include_dependencies) {
    // Merge all parsed HCL JSON objects into a single combined view so that
    // cross-file references can be resolved. We re-parse each file here to
    // get the raw (pre-variable-substitution) blocks, which still contain the
    // original reference strings (e.g. "${aws_subnet.main.id}").
    const mergedHcl: Record<string, unknown> = {};
    for (const file of params.files) {
      try {
        const json = await parseHclToJson(file.content, file.path);
        // Merge resource blocks from each file
        const resourceBlock = json["resource"];
        if (resourceBlock && typeof resourceBlock === "object" && !Array.isArray(resourceBlock)) {
          if (!mergedHcl["resource"]) {
            mergedHcl["resource"] = {};
          }
          Object.assign(
            mergedHcl["resource"] as Record<string, unknown>,
            resourceBlock as Record<string, unknown>
          );
        }
      } catch {
        // Silently skip files that failed to parse — they already produced
        // a parse_warning during the main parseTerraform call above.
      }
    }

    const graph = buildDependencyGraph(inventory.resources, mergedHcl);
    response["dependency_graph"] = graph;
    response["mermaid_diagram"] = generateMermaidDiagram(graph);
  }

  return response as unknown as object;
}
