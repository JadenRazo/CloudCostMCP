import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type CloudCostConfig, DEFAULT_CONFIG } from "./types/config.js";

function getConfigDir(): string {
  return join(homedir(), ".cloudcost");
}

function loadFileConfig(): Partial<CloudCostConfig> {
  const configPath = join(getConfigDir(), "config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function loadEnvConfig(): Partial<CloudCostConfig> {
  const config: Partial<CloudCostConfig> = {};
  const env = process.env;

  if (env.CLOUDCOST_CACHE_TTL || env.CLOUDCOST_CACHE_PATH) {
    const parsedTtl = env.CLOUDCOST_CACHE_TTL
      ? parseInt(env.CLOUDCOST_CACHE_TTL, 10)
      : NaN;
    config.cache = {
      ttl_seconds: !isNaN(parsedTtl) ? parsedTtl : DEFAULT_CONFIG.cache.ttl_seconds,
      db_path: env.CLOUDCOST_CACHE_PATH ?? "",
    };
  }

  if (env.CLOUDCOST_LOG_LEVEL) {
    config.logging = {
      level: env.CLOUDCOST_LOG_LEVEL as CloudCostConfig["logging"]["level"],
    };
  }

  if (env.CLOUDCOST_MONTHLY_HOURS || env.CLOUDCOST_INCLUDE_DATA_TRANSFER !== undefined || env.CLOUDCOST_PRICING_MODEL) {
    const parsedHours = env.CLOUDCOST_MONTHLY_HOURS
      ? parseInt(env.CLOUDCOST_MONTHLY_HOURS, 10)
      : NaN;
    const rawIncludeTransfer = env.CLOUDCOST_INCLUDE_DATA_TRANSFER;
    const includeDataTransfer =
      rawIncludeTransfer !== undefined
        ? rawIncludeTransfer.toLowerCase() !== "false" && rawIncludeTransfer !== "0"
        : DEFAULT_CONFIG.pricing.include_data_transfer;
    const validModels = ["on-demand", "spot", "reserved-1yr", "reserved-3yr"] as const;
    const envModel = env.CLOUDCOST_PRICING_MODEL as string | undefined;
    const pricingModel = envModel && (validModels as readonly string[]).includes(envModel)
      ? (envModel as typeof validModels[number])
      : DEFAULT_CONFIG.pricing.pricing_model;
    config.pricing = {
      ...DEFAULT_CONFIG.pricing,
      ...config.pricing,
      monthly_hours: !isNaN(parsedHours) ? parsedHours : DEFAULT_CONFIG.pricing.monthly_hours,
      include_data_transfer: includeDataTransfer,
      pricing_model: pricingModel,
    };
  }

  if (env.CLOUDCOST_RESOLVE_MODULES !== undefined) {
    config.parser = {
      resolve_modules: env.CLOUDCOST_RESOLVE_MODULES !== "false" && env.CLOUDCOST_RESOLVE_MODULES !== "0",
    };
  }

  return config;
}

export function loadConfig(): CloudCostConfig {
  const fileConfig = loadFileConfig();
  const envConfig = loadEnvConfig();

  const defaultDbPath = join(getConfigDir(), "cache.db");

  return {
    cache: {
      ...DEFAULT_CONFIG.cache,
      db_path: defaultDbPath,
      ...fileConfig.cache,
      ...envConfig.cache,
    },
    pricing: {
      ...DEFAULT_CONFIG.pricing,
      ...fileConfig.pricing,
      ...envConfig.pricing,
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...fileConfig.logging,
      ...envConfig.logging,
    },
    parser: {
      ...DEFAULT_CONFIG.parser,
      ...fileConfig.parser,
      ...envConfig.parser,
    },
  };
}
