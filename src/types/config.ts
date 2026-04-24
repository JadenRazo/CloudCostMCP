export interface BudgetConfig {
  monthly_limit?: number;
  per_resource_limit?: number;
  warn_percentage?: number;
}

export interface GuardrailConfig {
  max_monthly?: number;
  max_per_resource?: number;
  warn_ratio?: number;
}

export interface CloudCostConfig {
  cache: CacheConfig;
  pricing: PricingConfig;
  logging: LogConfig;
  parser: ParserConfig;
  budget?: BudgetConfig;
  guardrail?: GuardrailConfig;
}

export interface CacheConfig {
  ttl_seconds: number;
  db_path: string;
}

export interface PricingConfig {
  monthly_hours: number;
  default_currency: string;
  aws_pricing_region: string;
  include_data_transfer: boolean;
  pricing_model: "on-demand" | "spot" | "reserved-1yr" | "reserved-3yr";
}

export interface LogConfig {
  level: "debug" | "info" | "warn" | "error";
}

export interface ParserConfig {
  /**
   * When true (default), local and registry Terraform modules are resolved and
   * their resources are included in cost estimates. Set to false to revert to
   * the previous behaviour of emitting a warning per module and skipping it.
   */
  resolve_modules: boolean;
}

export const DEFAULT_CONFIG: CloudCostConfig = {
  cache: {
    ttl_seconds: 86400,
    db_path: "",
  },
  pricing: {
    monthly_hours: 730,
    default_currency: "USD",
    aws_pricing_region: "us-east-1",
    include_data_transfer: true,
    pricing_model: "on-demand",
  },
  logging: {
    level: "info",
  },
  parser: {
    resolve_modules: true,
  },
  budget: {
    warn_percentage: 80,
  },
  guardrail: {
    warn_ratio: 0.8,
  },
};
