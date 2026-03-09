import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import { findEquivalent, findAllEquivalents } from "../mapping/resource-mapper.js";
import { mapInstance } from "../mapping/instance-mapper.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const getEquivalentsSchema = z.object({
  resource_type: z
    .string()
    .describe(
      "Terraform resource type to look up (e.g. aws_instance, google_compute_instance)"
    ),
  source_provider: z
    .enum(["aws", "azure", "gcp"])
    .describe("Cloud provider the resource type belongs to"),
  target_provider: z
    .enum(["aws", "azure", "gcp"])
    .optional()
    .describe(
      "Specific target provider. When omitted, equivalents for all providers are returned."
    ),
  instance_type: z
    .string()
    .optional()
    .describe(
      "Instance type / VM size to also map across providers (e.g. t3.large, Standard_D4s_v3)"
    ),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Return the cross-provider resource type equivalents for a given Terraform
 * resource type. Optionally also maps an instance type when provided.
 */
export async function getEquivalents(
  params: z.infer<typeof getEquivalentsSchema>
): Promise<object> {
  const sourceProvider = params.source_provider as CloudProvider;

  // Resource-type equivalents
  let resourceEquivalents: Partial<Record<string, string | null>>;

  if (params.target_provider) {
    const targetProvider = params.target_provider as CloudProvider;
    const equivalent = findEquivalent(
      params.resource_type,
      sourceProvider,
      targetProvider
    );
    resourceEquivalents = { [targetProvider]: equivalent };
  } else {
    resourceEquivalents = findAllEquivalents(params.resource_type, sourceProvider);
  }

  // Instance-type equivalents (optional)
  let instanceEquivalents:
    | Partial<Record<string, string | null>>
    | undefined;

  if (params.instance_type) {
    const providers: CloudProvider[] = ["aws", "azure", "gcp"];
    const targets = params.target_provider
      ? [params.target_provider as CloudProvider]
      : providers.filter((p) => p !== sourceProvider);

    instanceEquivalents = {};
    for (const target of targets) {
      instanceEquivalents[target] = mapInstance(
        params.instance_type,
        sourceProvider,
        target
      );
    }
  }

  return {
    resource_type: params.resource_type,
    source_provider: sourceProvider,
    resource_equivalents: resourceEquivalents,
    ...(instanceEquivalents !== undefined
      ? {
          instance_type: params.instance_type,
          instance_equivalents: instanceEquivalents,
        }
      : {}),
  };
}
