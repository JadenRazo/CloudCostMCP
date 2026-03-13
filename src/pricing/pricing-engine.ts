import type { NormalizedPrice } from "../types/pricing.js";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import { PricingCache } from "./cache.js";
import { AwsBulkLoader } from "./aws/bulk-loader.js";
import { AzureRetailClient } from "./azure/retail-client.js";
import { GcpBundledLoader } from "./gcp/bundled-loader.js";
import { CloudBillingClient } from "./gcp/cloud-billing-client.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// PricingProvider interface
// ---------------------------------------------------------------------------

/**
 * Common interface that all cloud provider pricing implementations must satisfy.
 * Each method returns null when no pricing information is available for the
 * requested combination of parameters.
 */
export interface PricingProvider {
  getComputePrice(
    instanceType: string,
    region: string,
    os?: string
  ): Promise<NormalizedPrice | null>;

  getDatabasePrice(
    instanceType: string,
    region: string,
    engine?: string
  ): Promise<NormalizedPrice | null>;

  getStoragePrice(
    storageType: string,
    region: string,
    sizeGb?: number
  ): Promise<NormalizedPrice | null>;

  getLoadBalancerPrice(
    type: string,
    region: string
  ): Promise<NormalizedPrice | null>;

  getNatGatewayPrice(region: string): Promise<NormalizedPrice | null>;

  getKubernetesPrice(region: string, mode?: string): Promise<NormalizedPrice | null>;
}

// ---------------------------------------------------------------------------
// Provider adapters – thin wrappers that satisfy PricingProvider on top of
// the underlying loader / client classes.
// ---------------------------------------------------------------------------

class AwsProvider implements PricingProvider {
  private loader: AwsBulkLoader;

  constructor(cache: PricingCache) {
    this.loader = new AwsBulkLoader(cache);
  }

  getComputePrice(
    instanceType: string,
    region: string,
    os?: string
  ): Promise<NormalizedPrice | null> {
    return this.loader.getComputePrice(instanceType, region, os);
  }

  getDatabasePrice(
    instanceType: string,
    region: string,
    engine?: string
  ): Promise<NormalizedPrice | null> {
    return this.loader.getDatabasePrice(instanceType, region, engine);
  }

  getStoragePrice(
    storageType: string,
    region: string,
    _sizeGb?: number
  ): Promise<NormalizedPrice | null> {
    return this.loader.getStoragePrice(storageType, region);
  }

  getLoadBalancerPrice(
    _type: string,
    region: string
  ): Promise<NormalizedPrice | null> {
    return this.loader.getLoadBalancerPrice(region);
  }

  getNatGatewayPrice(region: string): Promise<NormalizedPrice | null> {
    return this.loader.getNatGatewayPrice(region);
  }

  getKubernetesPrice(region: string): Promise<NormalizedPrice | null> {
    return this.loader.getKubernetesPrice(region);
  }
}

class AzureProvider implements PricingProvider {
  private client: AzureRetailClient;

  constructor(cache: PricingCache) {
    this.client = new AzureRetailClient(cache);
  }

  getComputePrice(
    instanceType: string,
    region: string,
    os?: string
  ): Promise<NormalizedPrice | null> {
    return this.client.getComputePrice(instanceType, region, os);
  }

  getDatabasePrice(
    instanceType: string,
    region: string,
    engine?: string
  ): Promise<NormalizedPrice | null> {
    return this.client.getDatabasePrice(instanceType, region, engine);
  }

  getStoragePrice(
    storageType: string,
    region: string,
    _sizeGb?: number
  ): Promise<NormalizedPrice | null> {
    return this.client.getStoragePrice(storageType, region);
  }

  getLoadBalancerPrice(
    _type: string,
    region: string
  ): Promise<NormalizedPrice | null> {
    return this.client.getLoadBalancerPrice(region);
  }

  getNatGatewayPrice(region: string): Promise<NormalizedPrice | null> {
    return this.client.getNatGatewayPrice(region);
  }

  getKubernetesPrice(region: string): Promise<NormalizedPrice | null> {
    return this.client.getKubernetesPrice(region);
  }
}

class GcpProvider implements PricingProvider {
  private loader: GcpBundledLoader;
  private liveClient: CloudBillingClient;

  constructor(cache: PricingCache) {
    this.loader = new GcpBundledLoader();
    this.liveClient = new CloudBillingClient(cache);
  }

  async getComputePrice(
    instanceType: string,
    region: string,
    _os?: string
  ): Promise<NormalizedPrice | null> {
    try {
      const live = await this.liveClient.fetchComputeSkus(instanceType, region);
      if (live) return live;
    } catch (err) {
      logger.warn("GCP live compute pricing failed, falling back to bundled", {
        instanceType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return this.loader.getComputePrice(instanceType, region);
  }

  async getDatabasePrice(
    instanceType: string,
    region: string,
    _engine?: string
  ): Promise<NormalizedPrice | null> {
    try {
      const live = await this.liveClient.fetchDatabaseSkus(instanceType, region);
      if (live) return live;
    } catch (err) {
      logger.warn("GCP live database pricing failed, falling back to bundled", {
        instanceType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return this.loader.getDatabasePrice(instanceType, region);
  }

  async getStoragePrice(
    storageType: string,
    region: string,
    _sizeGb?: number
  ): Promise<NormalizedPrice | null> {
    // Persistent disk types (pd-*) are not in the Cloud Storage service;
    // they come from the Compute Engine service and are not individually
    // catalogued at the instance level, so fall back to bundled data.
    if (storageType.startsWith("pd-")) {
      return this.loader.getDiskPrice(storageType, region);
    }

    try {
      const live = await this.liveClient.fetchStorageSkus(storageType, region);
      if (live) return live;
    } catch (err) {
      logger.warn("GCP live storage pricing failed, falling back to bundled", {
        storageType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return this.loader.getStoragePrice(storageType, region);
  }

  getLoadBalancerPrice(
    _type: string,
    region: string
  ): Promise<NormalizedPrice | null> {
    // Load balancer pricing is fixed/infrastructure — bundled data is accurate.
    return this.loader.getLoadBalancerPrice(region);
  }

  getNatGatewayPrice(region: string): Promise<NormalizedPrice | null> {
    // NAT pricing is fixed/infrastructure — bundled data is accurate.
    return this.loader.getNatGatewayPrice(region);
  }

  getKubernetesPrice(region: string, mode?: string): Promise<NormalizedPrice | null> {
    // GKE control plane pricing is fixed — bundled data is accurate.
    return this.loader.getKubernetesPrice(
      region,
      mode === "autopilot" ? "autopilot" : "standard"
    );
  }
}

// ---------------------------------------------------------------------------
// PricingEngine – unified entry point
// ---------------------------------------------------------------------------

/**
 * PricingEngine holds one PricingProvider instance per cloud provider and
 * exposes a generic getPrice() method that dispatches to the right backend.
 *
 * The engine is intentionally thin: it does not contain pricing logic itself,
 * only routing and provider lifecycle management.
 */
export class PricingEngine {
  private providers: Map<CloudProvider, PricingProvider> = new Map();

  constructor(cache: PricingCache, _config: CloudCostConfig) {
    this.providers.set("aws", new AwsProvider(cache));
    this.providers.set("azure", new AzureProvider(cache));
    this.providers.set("gcp", new GcpProvider(cache));
  }

  /**
   * Return the PricingProvider for a specific cloud provider.
   * Throws if the provider is not registered (should never happen for the
   * three known providers).
   */
  getProvider(provider: CloudProvider): PricingProvider {
    const p = this.providers.get(provider);
    if (!p) {
      throw new Error(`Unknown cloud provider: ${provider}`);
    }
    return p;
  }

  /**
   * Generic price lookup that maps service/resourceType strings to the
   * appropriate method on the underlying PricingProvider.
   *
   * Supported service values (case-insensitive):
   *   compute, ec2, vm, instance        → getComputePrice
   *   database, rds, sql, db            → getDatabasePrice
   *   storage, ebs, disk, gcs           → getStoragePrice
   *   lb, load-balancer, alb, nlb       → getLoadBalancerPrice
   *   nat, nat-gateway                  → getNatGatewayPrice
   *   k8s, kubernetes, eks, aks, gke    → getKubernetesPrice
   */
  async getPrice(
    provider: CloudProvider,
    service: string,
    resourceType: string,
    region: string,
    attributes: Record<string, string> = {}
  ): Promise<NormalizedPrice | null> {
    const p = this.getProvider(provider);
    const svc = service.toLowerCase();

    logger.debug("PricingEngine.getPrice", {
      provider,
      service,
      resourceType,
      region,
    });

    if (
      svc === "compute" ||
      svc === "ec2" ||
      svc === "vm" ||
      svc === "instance" ||
      svc === "virtual-machines"
    ) {
      return p.getComputePrice(resourceType, region, attributes.os);
    }

    if (
      svc === "database" ||
      svc === "rds" ||
      svc === "sql" ||
      svc === "db" ||
      svc === "cloud-sql" ||
      svc === "azure-database"
    ) {
      return p.getDatabasePrice(resourceType, region, attributes.engine);
    }

    if (
      svc === "storage" ||
      svc === "ebs" ||
      svc === "disk" ||
      svc === "gcs" ||
      svc === "managed-disks" ||
      svc === "persistent-disk" ||
      svc === "cloud-storage"
    ) {
      const sizeGb = attributes.size_gb
        ? parseFloat(attributes.size_gb)
        : undefined;
      return p.getStoragePrice(resourceType, region, sizeGb);
    }

    if (
      svc === "lb" ||
      svc === "load-balancer" ||
      svc === "alb" ||
      svc === "nlb" ||
      svc === "elb" ||
      svc === "cloud-load-balancing"
    ) {
      return p.getLoadBalancerPrice(resourceType, region);
    }

    if (svc === "nat" || svc === "nat-gateway" || svc === "cloud-nat") {
      return p.getNatGatewayPrice(region);
    }

    if (
      svc === "k8s" ||
      svc === "kubernetes" ||
      svc === "eks" ||
      svc === "aks" ||
      svc === "gke"
    ) {
      return p.getKubernetesPrice(region, attributes.mode);
    }

    logger.warn("PricingEngine: unrecognised service", { service, provider });
    return null;
  }
}
