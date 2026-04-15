import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const getPricingSchema = z.object({
  provider: z.enum(["aws", "azure", "gcp"]).describe("Cloud provider to look up pricing for"),
  service: z
    .enum([
      "compute",
      "database",
      "storage",
      "network",
      "load_balancer",
      "nat_gateway",
      "kubernetes",
      "gpu",
    ])
    .describe(
      "Service category (network defaults to nat_gateway for backward compatibility; gpu returns accelerator pricing where supported)",
    ),
  resource_type: z
    .string()
    .describe(
      "Instance type, storage type, or resource identifier (e.g. t3.large, gp3, Standard_D4s_v3)",
    ),
  region: z.string().describe("Cloud region (e.g. us-east-1, eastus, us-central1)"),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Perform a direct pricing lookup via the PricingEngine and return the
 * NormalizedPrice for the requested combination of provider, service,
 * resource type, and region.
 *
 * Returns null in the `price` field when no pricing data is available.
 */
export async function getPricing(
  params: z.infer<typeof getPricingSchema>,
  pricingEngine: PricingEngine,
): Promise<object> {
  const provider = params.provider as CloudProvider;

  // Map the user-facing service enum to an internal service identifier that
  // PricingEngine.getPrice() recognises.
  const serviceMap: Record<string, string> = {
    compute: "compute",
    database: "database",
    storage: "storage",
    network: "nat-gateway",
    load_balancer: "load-balancer",
    nat_gateway: "nat-gateway",
    kubernetes: "kubernetes",
    gpu: "gpu",
  };

  const service = serviceMap[params.service] ?? params.service;

  const rawPrice = await pricingEngine.getPrice(
    provider,
    service,
    params.resource_type,
    params.region,
  );

  // Strip verbose / redundant fields from the price object when present.
  let price: Record<string, unknown> | null = null;
  if (rawPrice !== null) {
    const {
      description: _d,
      attributes,
      ...priceRest
    } = rawPrice as typeof rawPrice & {
      description?: unknown;
      attributes?: Record<string, string>;
    };
    price = { ...priceRest };
    // Only include attributes when the object is non-empty.
    if (attributes && Object.keys(attributes).length > 0) {
      price.attributes = attributes;
    }
  }

  return { price };
}
