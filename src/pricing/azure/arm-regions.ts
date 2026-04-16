/**
 * Canonical map from friendly Azure region names (and common aliases) to
 * the `armRegionName` values used by the Azure Retail Prices API and ARM
 * resource manager.
 *
 * Sources:
 *  - https://learn.microsoft.com/en-us/azure/reliability/regions-list
 *  - `az account list-locations -o table`
 *
 * The map is intentionally permissive on the input side: keys include both
 * the canonical form (e.g. "eastus") and common variants with spaces,
 * hyphens, or mixed case (e.g. "East US", "east-us"). Values are always
 * canonical `armRegionName` strings.
 *
 * Exported so normalization can be reused across modules (retail client,
 * normalizer, tests, etc.) without duplicating the table.
 */
export const ARM_REGION_MAP: Record<string, string> = {
  // Americas
  eastus: "eastus",
  eastus2: "eastus2",
  eastus3: "eastus3",
  southcentralus: "southcentralus",
  westus: "westus",
  westus2: "westus2",
  westus3: "westus3",
  centralus: "centralus",
  northcentralus: "northcentralus",
  westcentralus: "westcentralus",
  canadacentral: "canadacentral",
  canadaeast: "canadaeast",
  brazilsouth: "brazilsouth",
  brazilsoutheast: "brazilsoutheast",
  mexicocentral: "mexicocentral",

  // Europe
  northeurope: "northeurope",
  westeurope: "westeurope",
  uksouth: "uksouth",
  ukwest: "ukwest",
  francecentral: "francecentral",
  francesouth: "francesouth",
  germanywestcentral: "germanywestcentral",
  germanynorth: "germanynorth",
  switzerlandnorth: "switzerlandnorth",
  switzerlandwest: "switzerlandwest",
  norwayeast: "norwayeast",
  norwaywest: "norwaywest",
  swedencentral: "swedencentral",
  swedensouth: "swedensouth",
  polandcentral: "polandcentral",
  italynorth: "italynorth",
  spaincentral: "spaincentral",

  // Asia Pacific
  eastasia: "eastasia",
  southeastasia: "southeastasia",
  japaneast: "japaneast",
  japanwest: "japanwest",
  australiaeast: "australiaeast",
  australiasoutheast: "australiasoutheast",
  australiacentral: "australiacentral",
  australiacentral2: "australiacentral2",
  centralindia: "centralindia",
  southindia: "southindia",
  westindia: "westindia",
  jioindiawest: "jioindiawest",
  jioindiacentral: "jioindiacentral",
  koreacentral: "koreacentral",
  koreasouth: "koreasouth",

  // Middle East / Africa
  uaenorth: "uaenorth",
  uaecentral: "uaecentral",
  qatarcentral: "qatarcentral",
  israelcentral: "israelcentral",
  southafricanorth: "southafricanorth",
  southafricawest: "southafricawest",
};

/**
 * Friendly-name aliases. Keys are lower-cased, stripped of non-alphanumerics
 * (so "East US 2", "east-us-2", "East US2" all collapse to "eastus2").
 * Values point back into ARM_REGION_MAP.
 */
const ALIASES: Record<string, string> = {
  // Americas
  eastus: "eastus",
  eastus2: "eastus2",
  eastus3: "eastus3",
  southcentralus: "southcentralus",
  westus: "westus",
  westus2: "westus2",
  westus3: "westus3",
  centralus: "centralus",
  northcentralus: "northcentralus",
  westcentralus: "westcentralus",
  canadacentral: "canadacentral",
  canadaeast: "canadaeast",
  brazilsouth: "brazilsouth",
  brazilsoutheast: "brazilsoutheast",
  mexicocentral: "mexicocentral",
  // Europe
  northeurope: "northeurope",
  westeurope: "westeurope",
  uksouth: "uksouth",
  ukwest: "ukwest",
  francecentral: "francecentral",
  francesouth: "francesouth",
  germanywestcentral: "germanywestcentral",
  germanynorth: "germanynorth",
  switzerlandnorth: "switzerlandnorth",
  switzerlandwest: "switzerlandwest",
  norwayeast: "norwayeast",
  norwaywest: "norwaywest",
  swedencentral: "swedencentral",
  swedensouth: "swedensouth",
  polandcentral: "polandcentral",
  italynorth: "italynorth",
  spaincentral: "spaincentral",
  // Asia Pacific
  eastasia: "eastasia",
  southeastasia: "southeastasia",
  japaneast: "japaneast",
  japanwest: "japanwest",
  australiaeast: "australiaeast",
  australiasoutheast: "australiasoutheast",
  australiacentral: "australiacentral",
  australiacentral2: "australiacentral2",
  centralindia: "centralindia",
  southindia: "southindia",
  westindia: "westindia",
  jioindiawest: "jioindiawest",
  jioindiacentral: "jioindiacentral",
  koreacentral: "koreacentral",
  koreasouth: "koreasouth",
  // Middle East / Africa
  uaenorth: "uaenorth",
  uaecentral: "uaecentral",
  qatarcentral: "qatarcentral",
  israelcentral: "israelcentral",
  southafricanorth: "southafricanorth",
  southafricawest: "southafricawest",
};

/**
 * Convert any friendly or canonical Azure region string into the official
 * `armRegionName`. Accepts inputs like "East US", "east-us", "EASTUS",
 * "East US 2", or already-canonical "eastus2". Unknown inputs fall back to
 * a best-effort lowercase/strip so the caller still gets *something* usable
 * rather than throwing — this preserves the legacy behaviour of the old
 * inline normalizer.
 */
export function toArmRegionName(region: string): string {
  if (!region) return region;
  const key = region.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIASES[key] ?? ARM_REGION_MAP[key] ?? key;
}
