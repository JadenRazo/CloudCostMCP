import { getRegionPriceMultipliers } from "../../data/loader.js";

// ---------------------------------------------------------------------------
// Fallback pricing data (approximate eastus on-demand prices, 2024)
// ---------------------------------------------------------------------------

export const VM_BASE_PRICES: Record<string, number> = {
  standard_b1s: 0.0104,
  standard_b1ms: 0.0207,
  standard_b2s: 0.0416,
  standard_b2ms: 0.0832,
  standard_b4ms: 0.166,
  standard_b8ms: 0.333,
  standard_b12ms: 0.499,
  standard_b16ms: 0.666,
  standard_d2s_v4: 0.096,
  standard_d4s_v4: 0.192,
  standard_d8s_v4: 0.384,
  standard_d2s_v5: 0.096,
  standard_d4s_v5: 0.192,
  standard_d8s_v5: 0.384,
  standard_d16s_v5: 0.768,
  standard_d32s_v5: 1.536,
  standard_d2ds_v5: 0.113,
  standard_d4ds_v5: 0.226,
  standard_d8ds_v5: 0.452,
  standard_d2ps_v5: 0.077,
  standard_d4ps_v5: 0.154,
  standard_e2s_v5: 0.126,
  standard_e4s_v5: 0.252,
  standard_e8s_v5: 0.504,
  standard_e16s_v5: 1.008,
  standard_e32s_v5: 2.016,
  standard_e2ds_v5: 0.144,
  standard_e4ds_v5: 0.288,
  standard_f2s_v2: 0.085,
  standard_f4s_v2: 0.17,
  standard_f8s_v2: 0.34,
  standard_f16s_v2: 0.68,
  standard_f32s_v2: 1.36,
  standard_l8s_v3: 0.624,
  standard_l16s_v3: 1.248,
  standard_nc4as_t4_v3: 0.526,
  standard_nc8as_t4_v3: 0.752,
  standard_e2ps_v5: 0.101,
  standard_e4ps_v5: 0.202,
  standard_e8ps_v5: 0.403,
};

// Disk prices are per GB/month
export const DISK_BASE_PRICES: Record<string, number> = {
  premium_lrs: 0.132,
  standard_lrs: 0.04,
  standardssd_lrs: 0.075,
  ultrassd_lrs: 0.12,
  premium_lrs_p10: 0.0052,
  premium_lrs_p20: 0.01,
  premium_lrs_p30: 0.0192,
  premium_lrs_p40: 0.0373,
};

// Azure DB for PostgreSQL Flexible prices (per hour)
export const DB_BASE_PRICES: Record<string, number> = {
  burstable_standard_b1ms: 0.044,
  burstable_standard_b2s: 0.088,
  burstable_standard_b4ms: 0.176,
  gp_standard_d2s_v3: 0.124,
  gp_standard_d4s_v3: 0.248,
  gp_standard_d8s_v3: 0.496,
  gp_standard_d16s_v3: 0.992,
  gp_standard_d2ds_v4: 0.124,
  gp_standard_d4ds_v4: 0.248,
  gp_standard_d8ds_v4: 0.496,
  gp_standard_d16ds_v4: 0.992,
  mo_standard_e2ds_v4: 0.17,
  mo_standard_e4ds_v4: 0.341,
  mo_standard_e8ds_v4: 0.682,
};

// ALB (Azure Load Balancer) pricing
export const ALB_HOURLY = 0.025;
export const ALB_RULE_HOURLY = 0.005;

// Azure NAT Gateway pricing
export const NAT_HOURLY = 0.045;
export const NAT_PER_GB = 0.045;

// AKS control plane (paid tier with uptime SLA)
export const AKS_HOURLY = 0.1;

export const CACHE_TTL = 86400; // 24 hours

export const RETAIL_API_BASE = "https://prices.azure.com/api/retail/prices";

// ---------------------------------------------------------------------------
// Regional price multiplier lookup -- reads from the shared data file so all
// providers use consistent values sourced from one place.
// ---------------------------------------------------------------------------

export function regionMultiplier(region: string): number {
  const multipliers = getRegionPriceMultipliers();
  return multipliers.azure[region.toLowerCase()] ?? 1.0;
}
