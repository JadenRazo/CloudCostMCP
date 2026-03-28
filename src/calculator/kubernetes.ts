import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { calculateComputeCost } from "./compute.js";

/**
 * Calculates the monthly cost for a Kubernetes cluster (EKS/AKS/GKE).
 *
 * Cost components:
 *  1. Control plane: hourly_price * monthly_hours
 *  2. Node groups: if node_count is available on the cluster resource itself,
 *     the compute cost per node is estimated and multiplied by node_count.
 *
 * Node group resources (aws_eks_node_group, google_container_node_pool, etc.)
 * should be costed separately through calculateComputeCost; this function
 * handles only the cluster-level control plane charges.
 */
export async function calculateKubernetesCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
  pricingEngine: PricingEngine,
  monthlyHours: number = 730,
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  // Control plane pricing.
  const k8sPrice = await pricingEngine.getProvider(targetProvider).getKubernetesPrice(targetRegion);

  let totalMonthly = 0;
  let pricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (k8sPrice) {
    const rawSource = k8sPrice.attributes?.pricing_source;
    if (rawSource === "bundled") {
      pricingSource = "bundled";
    } else if (rawSource === "fallback") {
      pricingSource = "fallback";
    } else {
      pricingSource = "live";
    }

    const controlPlaneCost = k8sPrice.price_per_unit * monthlyHours;
    breakdown.push({
      description: `Kubernetes control plane (${monthlyHours}h/month)`,
      unit: "Hrs",
      quantity: monthlyHours,
      unit_price: k8sPrice.price_per_unit,
      monthly_cost: controlPlaneCost,
    });
    totalMonthly += controlPlaneCost;
  } else {
    notes.push(`No pricing data found for ${resource.type} in ${targetRegion}`);
  }

  // Optional: node group cost if node_count is embedded in cluster attributes.
  const nodeCount =
    (resource.attributes.node_count as number | undefined) ??
    (resource.attributes.min_node_count as number | undefined);

  if (nodeCount && nodeCount > 0) {
    const nodeInstanceType =
      (resource.attributes.instance_type as string | undefined) ??
      (resource.attributes.vm_size as string | undefined) ??
      (resource.attributes.machine_type as string | undefined);

    if (nodeInstanceType) {
      // Construct a synthetic compute resource for a single node to price it.
      const nodeResource: ParsedResource = {
        ...resource,
        id: `${resource.id}/node`,
        type: "compute_node",
        name: `${resource.name}-node`,
        attributes: {
          instance_type: nodeInstanceType,
          vm_size: nodeInstanceType,
          machine_type: nodeInstanceType,
        },
      };

      const nodeCostEstimate = await calculateComputeCost(
        nodeResource,
        targetProvider,
        targetRegion,
        pricingEngine,
        monthlyHours,
      );

      if (nodeCostEstimate.monthly_cost > 0) {
        const nodeGroupCost = nodeCostEstimate.monthly_cost * nodeCount;
        breakdown.push({
          description: `${nodeCount}x node (${nodeInstanceType}) compute`,
          unit: "nodes",
          quantity: nodeCount,
          unit_price: nodeCostEstimate.monthly_cost,
          monthly_cost: nodeGroupCost,
        });
        totalMonthly += nodeGroupCost;
        notes.push(`Node cost estimated for ${nodeCount} nodes of type ${nodeInstanceType}`);
      }
    } else {
      notes.push(
        `node_count=${nodeCount} specified but no instance_type found; node compute cost excluded`,
      );
    }
  }

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: totalMonthly,
    yearly_cost: totalMonthly * 12,
    currency: "USD",
    breakdown,
    confidence: k8sPrice ? "medium" : "low",
    notes,
    pricing_source: pricingSource,
  };
}
