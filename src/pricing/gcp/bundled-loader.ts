import type { NormalizedPrice } from "../../types/pricing.js";
import { logger } from "../../logger.js";
import {
  getGcpComputePricing,
  getGcpSqlPricing,
  getGcpStoragePricing,
  getGcpDiskPricing,
} from "../../data/loader.js";
import {
  normalizeGcpCompute,
  normalizeGcpDatabase,
  normalizeGcpStorage,
  normalizeGcpDisk,
} from "./gcp-normalizer.js";
import { regionMultiplier } from "../region-multiplier.js";

// ---------------------------------------------------------------------------
// GCP-specific infrastructure pricing (not in bundled data files)
// ---------------------------------------------------------------------------

// Cloud Load Balancing (per forwarding rule / hour + per GB data processed)
const LB_FORWARDING_RULE_HOURLY = 0.025;
const LB_PER_GB = 0.008;

// Cloud NAT
const NAT_HOURLY = 0.044;
const NAT_PER_GB = 0.045;

// GKE control plane
// Standard cluster: $0.10/hr
// Autopilot: $0.0445/vCPU/hr estimate. Autopilot is actually billed per-pod
// across vCPU, memory and ephemeral storage, so this is an approximation.
//
// It used to be described as a fallback behind a live Cloud Billing catalog
// lookup. That was never true in practice: PricingEngine's getKubernetesPrice
// always routed here, and the live client it named could not authenticate
// anyway. The client has been removed, so this is simply the Autopilot number.
const GKE_STANDARD_HOURLY = 0.1;
const GKE_AUTOPILOT_VCPU_HOURLY = 0.0445;

export class GcpBundledLoader {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getComputePrice(machineType: string, region: string): Promise<NormalizedPrice | null> {
    try {
      const pricing = getGcpComputePricing();
      const regionPrices = pricing[region];

      if (!regionPrices) {
        logger.debug("GCP compute: region not found in bundled data", {
          region,
          machineType,
        });
        return Promise.resolve(null);
      }

      const price = regionPrices[machineType];
      if (price === undefined) {
        logger.debug("GCP compute: machine type not found in bundled data", {
          region,
          machineType,
        });
        return Promise.resolve(null);
      }

      return Promise.resolve(normalizeGcpCompute(machineType, price, region));
    } catch (err) {
      logger.error("GCP compute pricing load error", {
        machineType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
      return Promise.resolve(null);
    }
  }

  getDatabasePrice(tier: string, region: string): Promise<NormalizedPrice | null> {
    try {
      const pricing = getGcpSqlPricing();
      const regionPrices = pricing[region];

      if (!regionPrices) {
        logger.debug("GCP SQL: region not found in bundled data", {
          region,
          tier,
        });
        return Promise.resolve(null);
      }

      // "storage_per_gb" and "ha_multiplier" are metadata keys, not tiers
      const price = regionPrices[tier];
      if (price === undefined || tier === "storage_per_gb" || tier === "ha_multiplier") {
        logger.debug("GCP SQL: tier not found in bundled data", {
          region,
          tier,
        });
        return Promise.resolve(null);
      }

      return Promise.resolve(normalizeGcpDatabase(tier, price, region));
    } catch (err) {
      logger.error("GCP SQL pricing load error", {
        tier,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
      return Promise.resolve(null);
    }
  }

  getStoragePrice(storageClass: string, region: string): Promise<NormalizedPrice | null> {
    try {
      const pricing = getGcpStoragePricing();
      const regionPrices = pricing[region];

      if (!regionPrices) {
        logger.debug("GCP Storage: region not found in bundled data", {
          region,
          storageClass,
        });
        return Promise.resolve(null);
      }

      const classKey = storageClass.toUpperCase() as keyof typeof regionPrices;
      const price = regionPrices[classKey];
      if (price === undefined) {
        logger.debug("GCP Storage: storage class not found in bundled data", {
          region,
          storageClass,
        });
        return Promise.resolve(null);
      }

      return Promise.resolve(normalizeGcpStorage(storageClass.toUpperCase(), price, region));
    } catch (err) {
      logger.error("GCP Storage pricing load error", {
        storageClass,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
      return Promise.resolve(null);
    }
  }

  getDiskPrice(diskType: string, region: string): Promise<NormalizedPrice | null> {
    try {
      const pricing = getGcpDiskPricing();
      const regionPrices = pricing[region];

      if (!regionPrices) {
        logger.debug("GCP Disk: region not found in bundled data", {
          region,
          diskType,
        });
        return Promise.resolve(null);
      }

      const diskKey = diskType as keyof typeof regionPrices;
      const price = regionPrices[diskKey];
      if (price === undefined) {
        logger.debug("GCP Disk: disk type not found in bundled data", {
          region,
          diskType,
        });
        return Promise.resolve(null);
      }

      return Promise.resolve(normalizeGcpDisk(diskType, price, region));
    } catch (err) {
      logger.error("GCP Disk pricing load error", {
        diskType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
      return Promise.resolve(null);
    }
  }

  getLoadBalancerPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier("gcp", region);
    return Promise.resolve({
      provider: "gcp",
      service: "cloud-load-balancing",
      resource_type: "forwarding-rule",
      region,
      unit: "h",
      price_per_unit: LB_FORWARDING_RULE_HOURLY * multiplier,
      currency: "USD",
      description: "GCP Cloud Load Balancing forwarding rule (per hour + data processed)",
      attributes: {
        per_gb_price: String(LB_PER_GB * multiplier),
      },
      effective_date: new Date().toISOString(),
    });
  }

  getNatGatewayPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier("gcp", region);
    return Promise.resolve({
      provider: "gcp",
      service: "cloud-nat",
      resource_type: "nat-gateway",
      region,
      unit: "h",
      price_per_unit: NAT_HOURLY * multiplier,
      currency: "USD",
      description: "GCP Cloud NAT (per gateway/hour + data processed)",
      attributes: {
        per_gb_price: String(NAT_PER_GB * multiplier),
      },
      effective_date: new Date().toISOString(),
    });
  }

  getKubernetesPrice(
    region: string,
    mode: "standard" | "autopilot" = "standard",
  ): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier("gcp", region);
    const baseHourly = mode === "autopilot" ? GKE_AUTOPILOT_VCPU_HOURLY : GKE_STANDARD_HOURLY;

    return Promise.resolve({
      provider: "gcp",
      service: "gke",
      resource_type: "cluster",
      region,
      unit: "h",
      price_per_unit: baseHourly * multiplier,
      currency: "USD",
      description:
        mode === "autopilot"
          ? "GCP GKE Autopilot cluster (estimated per-vCPU/hr; actual billing is per-pod resources)"
          : "GCP GKE Standard cluster (per cluster/hour)",
      attributes: {
        mode,
        ...(mode === "autopilot" && {
          pricing_model: "per_vcpu_hour",
          pricing_note:
            "Autopilot charges per pod vCPU and memory. This price is a per-vCPU/hr approximation for cluster-level cost estimation.",
        }),
      },
      effective_date: new Date().toISOString(),
    });
  }
}
