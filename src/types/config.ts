export interface CloudCostConfig {
  cache: CacheConfig;
  pricing: PricingConfig;
  logging: LogConfig;
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
}

export interface LogConfig {
  level: "debug" | "info" | "warn" | "error";
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
  },
  logging: {
    level: "info",
  },
};
