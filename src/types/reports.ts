import type { CloudProvider } from "./resources.js";

export type ReportFormat = "markdown" | "json" | "csv" | "focus";

export interface ReportOptions {
  format: ReportFormat;
  include_breakdown: boolean;
  include_recommendations: boolean;
  currency: string;
  group_by?: "resource" | "service" | "tag";
  group_by_tag_key?: string;
}

export interface OptimizationRecommendation {
  resource_id: string;
  resource_name: string;
  type: "right_size" | "reserved" | "switch_provider" | "storage_tier" | "remove_unused";
  description: string;
  current_monthly_cost: number;
  estimated_monthly_cost: number;
  monthly_savings: number;
  percentage_savings: number;
  confidence: "high" | "medium" | "low";
  provider?: CloudProvider;
}

export interface CostReport {
  title: string;
  generated_at: string;
  source_provider: CloudProvider;
  source_region: string;
  resource_count: number;
  providers_compared: CloudProvider[];
  content: string;
  format: ReportFormat;
}
