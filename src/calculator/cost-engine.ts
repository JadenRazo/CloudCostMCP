import type { ParsedResource, CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostBreakdown } from "../types/pricing.js";
import type { CloudCostConfig } from "../types/config.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { calculateComputeCost } from "./compute.js";
import { calculateDatabaseCost } from "./database.js";
import { calculateStorageCost } from "./storage.js";
import { calculateNatGatewayCost, calculateLoadBalancerCost } from "./network.js";
import { calculateKubernetesCost } from "./kubernetes.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Resource type classification
// ---------------------------------------------------------------------------

const COMPUTE_TYPES = new Set([
  "aws_instance",
  "azurerm_linux_virtual_machine",
  "azurerm_windows_virtual_machine",
  "google_compute_instance",
  // Node groups – cost their compute like VMs.
  "aws_eks_node_group",
  "azurerm_kubernetes_cluster_node_pool",
  "google_container_node_pool",
  "compute_node",
]);

const DATABASE_TYPES = new Set([
  "aws_db_instance",
  "azurerm_postgresql_flexible_server",
  "azurerm_mysql_flexible_server",
  "azurerm_mssql_server",
  "google_sql_database_instance",
]);

const BLOCK_STORAGE_TYPES = new Set([
  "aws_ebs_volume",
  "azurerm_managed_disk",
  "google_compute_disk",
]);

const OBJECT_STORAGE_TYPES = new Set([
  "aws_s3_bucket",
  "azurerm_storage_account",
  "google_storage_bucket",
]);

const NAT_GATEWAY_TYPES = new Set([
  "aws_nat_gateway",
  "azurerm_nat_gateway",
  "google_compute_router_nat",
]);

const LOAD_BALANCER_TYPES = new Set([
  "aws_lb",
  "aws_alb",
  "azurerm_lb",
  "azurerm_application_gateway",
  "google_compute_forwarding_rule",
]);

const KUBERNETES_TYPES = new Set([
  "aws_eks_cluster",
  "azurerm_kubernetes_cluster",
  "google_container_cluster",
]);

// ---------------------------------------------------------------------------
// Service label helper (for by_service aggregation)
// ---------------------------------------------------------------------------

function serviceLabel(resourceType: string): string {
  if (COMPUTE_TYPES.has(resourceType)) return "compute";
  if (DATABASE_TYPES.has(resourceType)) return "database";
  if (BLOCK_STORAGE_TYPES.has(resourceType)) return "block_storage";
  if (OBJECT_STORAGE_TYPES.has(resourceType)) return "object_storage";
  if (NAT_GATEWAY_TYPES.has(resourceType)) return "network";
  if (LOAD_BALANCER_TYPES.has(resourceType)) return "network";
  if (KUBERNETES_TYPES.has(resourceType)) return "kubernetes";
  return "other";
}

// ---------------------------------------------------------------------------
// CostEngine
// ---------------------------------------------------------------------------

/**
 * CostEngine is the top-level orchestrator for multi-cloud cost estimation.
 *
 * It dispatches each ParsedResource to the appropriate sub-calculator based on
 * resource type, collects the resulting CostEstimate objects, and aggregates
 * them into a CostBreakdown with per-service totals.
 */
export class CostEngine {
  private pricingEngine: PricingEngine;
  private monthlyHours: number;

  constructor(pricingEngine: PricingEngine, config: CloudCostConfig) {
    this.pricingEngine = pricingEngine;
    this.monthlyHours = config.pricing.monthly_hours;
  }

  /**
   * Calculates the cost of a single resource on a target provider.
   */
  async calculateCost(
    resource: ParsedResource,
    targetProvider: CloudProvider,
    targetRegion: string
  ): Promise<CostEstimate> {
    const type = resource.type;

    logger.debug("CostEngine.calculateCost", {
      resourceId: resource.id,
      type,
      targetProvider,
      targetRegion,
    });

    if (COMPUTE_TYPES.has(type)) {
      return calculateComputeCost(
        resource,
        targetProvider,
        targetRegion,
        this.pricingEngine,
        this.monthlyHours
      );
    }

    if (DATABASE_TYPES.has(type)) {
      return calculateDatabaseCost(
        resource,
        targetProvider,
        targetRegion,
        this.pricingEngine,
        this.monthlyHours
      );
    }

    if (BLOCK_STORAGE_TYPES.has(type) || OBJECT_STORAGE_TYPES.has(type)) {
      return calculateStorageCost(
        resource,
        targetProvider,
        targetRegion,
        this.pricingEngine
      );
    }

    if (NAT_GATEWAY_TYPES.has(type)) {
      return calculateNatGatewayCost(
        resource,
        targetProvider,
        targetRegion,
        this.pricingEngine,
        this.monthlyHours
      );
    }

    if (LOAD_BALANCER_TYPES.has(type)) {
      return calculateLoadBalancerCost(
        resource,
        targetProvider,
        targetRegion,
        this.pricingEngine,
        this.monthlyHours
      );
    }

    if (KUBERNETES_TYPES.has(type)) {
      return calculateKubernetesCost(
        resource,
        targetProvider,
        targetRegion,
        this.pricingEngine,
        this.monthlyHours
      );
    }

    // Unsupported resource type – return a zero-cost estimate so callers can
    // still include it in the breakdown without crashing.
    logger.warn("CostEngine: unsupported resource type", { type, targetProvider });
    return {
      resource_id: resource.id,
      resource_type: type,
      resource_name: resource.name,
      provider: targetProvider,
      region: targetRegion,
      monthly_cost: 0,
      yearly_cost: 0,
      currency: "USD",
      breakdown: [],
      confidence: "low",
      notes: [`Resource type "${type}" is not yet supported by the cost engine`],
      pricing_source: "fallback" as const,
    };
  }

  /**
   * Calculates costs for all resources and aggregates them into a CostBreakdown.
   *
   * Resources that fail to produce a cost estimate are logged and skipped rather
   * than letting a single failure abort the entire calculation.
   */
  async calculateBreakdown(
    resources: ParsedResource[],
    targetProvider: CloudProvider,
    targetRegion: string
  ): Promise<CostBreakdown> {
    const estimates: CostEstimate[] = [];
    const byService: Record<string, number> = {};
    const warnings: string[] = [];

    for (const resource of resources) {
      try {
        const estimate = await this.calculateCost(
          resource,
          targetProvider,
          targetRegion
        );
        estimates.push(estimate);

        const svc = serviceLabel(resource.type);
        byService[svc] = (byService[svc] ?? 0) + estimate.monthly_cost;

        // Surface warnings for fallback pricing and missing data.
        if (estimate.pricing_source === "fallback") {
          warnings.push(
            `${estimate.resource_name} (${estimate.resource_type}): using fallback/bundled pricing data`
          );
        }
        if (estimate.monthly_cost === 0 && estimate.confidence === "low") {
          warnings.push(
            `No pricing data found for ${estimate.resource_type} in ${targetRegion} — cost reported as $0`
          );
        }
      } catch (err) {
        logger.error("CostEngine: failed to calculate cost for resource", {
          resourceId: resource.id,
          type: resource.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const totalMonthly = estimates.reduce((sum, e) => sum + e.monthly_cost, 0);

    return {
      provider: targetProvider,
      region: targetRegion,
      total_monthly: Math.round(totalMonthly * 100) / 100,
      total_yearly: Math.round(totalMonthly * 12 * 100) / 100,
      currency: "USD",
      by_service: Object.fromEntries(
        Object.entries(byService).map(([k, v]) => [k, Math.round(v * 100) / 100])
      ),
      by_resource: estimates,
      generated_at: new Date().toISOString(),
      warnings,
    };
  }
}
