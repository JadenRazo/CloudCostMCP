import type { CloudProvider } from "./resources.js";

export interface NormalizedPrice {
  provider: CloudProvider;
  service: string;
  resource_type: string;
  region: string;
  unit: string;
  price_per_unit: number;
  currency: string;
  tier?: string;
  description?: string;
  attributes: Record<string, string>;
  effective_date?: string;
}

export interface PricingMetadata {
  provider: CloudProvider;
  region: string;
  service: string;
  fetched_at: string;
  source_url?: string;
  cache_ttl_seconds: number;
}

export interface CostEstimate {
  resource_id: string;
  resource_type: string;
  resource_name: string;
  provider: CloudProvider;
  region: string;
  monthly_cost: number;
  yearly_cost: number;
  currency: string;
  breakdown: CostLineItem[];
  confidence: "high" | "medium" | "low";
  notes: string[];
  pricing_source: "live" | "fallback" | "bundled" | "spot-estimate";
}

export interface CostLineItem {
  description: string;
  unit: string;
  quantity: number;
  unit_price: number;
  monthly_cost: number;
}

export interface CostBreakdown {
  provider: CloudProvider;
  region: string;
  total_monthly: number;
  total_yearly: number;
  currency: string;
  by_service: Record<string, number>;
  by_resource: CostEstimate[];
  generated_at: string;
  warnings: string[];
  budget_warnings?: string[];
}

export interface ProviderComparison {
  source_provider: CloudProvider;
  comparisons: CostBreakdown[];
  savings_summary: SavingsSummary[];
  generated_at: string;
}

export interface SavingsSummary {
  provider: CloudProvider;
  total_monthly: number;
  difference_from_source: number;
  percentage_difference: number;
}

export interface CostProjection {
  projections: {
    months: number;
    on_demand_total: number;
    reserved_total: number | null;
    savings: number | null;
    savings_percentage: number | null;
  }[];
  break_even_month: number | null;
  recommended_commitment: string | null;
}
