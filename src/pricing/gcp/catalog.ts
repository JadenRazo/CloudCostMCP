/**
 * Required on-demand portion of gcosts' generator, adapted from
 * Cyclenerd/google-cloud-pricing-cost-calculator at ac8edd2734343d1f43a759694c7a3569cea6931f.
 * Copyright 2022-2025 Nils Knieling. Licensed under Apache-2.0;
 * see scripts/gcp/LICENSE and scripts/gcp/README.md for attribution and changes.
 */
import { createHash } from "node:crypto";
import { parseCsvLine } from "../aws/csv-parser.js";
import { fetchWithRetry } from "../fetch-utils.js";
import { GCP_PRICING_SOURCE_URL } from "../../data/pricing-sources.js";

export interface CatalogSku {
  skuId: string;
  description: string;
  category: {
    serviceDisplayName: string;
    resourceFamily: string;
    resourceGroup: string;
    usageType: string;
  };
  serviceRegions: string[];
  pricingInfo: Array<{
    effectiveTime: string;
    pricingExpression: {
      usageUnit: string;
      tieredRates: Array<{
        startUsageAmount?: number;
        unitPrice: { currencyCode: string; units?: string; nanos?: number };
      }>;
    };
  }>;
}

export interface CatalogReceipt {
  url: string;
  retrieved_at: string;
  sha256: string;
  source_vintage: string;
  pages: number;
  sku_count: number;
}

export interface MachineDefinition {
  cpu: number;
  ram: number;
  a100?: number;
  "a100-80gb"?: number;
  "local-ssd"?: number;
}

export interface CatalogEntry {
  cost: Record<string, { hour?: number; month?: number }>;
}

export interface CatalogDocument {
  about: { generated: string; timestamp: number };
  compute: {
    instance: Record<string, CatalogEntry>;
    storage: Record<string, CatalogEntry>;
  };
  storage: { bucket: Record<string, CatalogEntry> };
  catalog: { sources: CatalogReceipt[]; generator: string };
}

interface MappingRule {
  id: string;
  service: string;
  family: string;
  group: string;
  description: RegExp;
}

export function parseCatalogMappings(csv: string): MappingRule[] {
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => parseCsvLine(line))
    .filter((row) => row[1])
    .map(([id, service, family, group, description]) => ({
      id,
      service,
      family,
      group,
      // SQLite LIKE semantics: % and _ are wildcards; later CSV rows win.
      description: new RegExp(
        "^" +
          description
            .split("")
            .map((c) =>
              c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("") +
          "$",
        "i",
      ),
    }));
}

export function catalogMapping(sku: CatalogSku, rules: MappingRule[]): string | undefined {
  const c = sku.category;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (
      rule.service === c.serviceDisplayName &&
      rule.family === c.resourceFamily &&
      rule.group === c.resourceGroup &&
      rule.description.test(sku.description)
    )
      return rule.id;
  }
  return undefined;
}

/** Return USD per usage unit, excluding free allowance just as gcosts does. */
export function catalogRate(sku: CatalogSku, expectedUnit: string, now = Date.now()): number {
  const info = sku.pricingInfo.at(-1);
  const effective = Date.parse(info?.effectiveTime ?? "");
  // No requested historical range: Google's latest price must be within 12h.
  // Allow 24h for API clock variation; never substitute our clock for its date.
  if (!Number.isFinite(effective) || effective > now || now - effective > 86_400_000) {
    throw new Error(`SKU ${sku.skuId} has missing, future or stale current pricing`);
  }
  const expression = info!.pricingExpression;
  if (expression.usageUnit !== expectedUnit) {
    throw new Error(`SKU ${sku.skuId}: expected ${expectedUnit}, got ${expression.usageUnit}`);
  }
  const rates = expression.tieredRates;
  if (!rates.length) throw new Error(`SKU ${sku.skuId} has no pricing tiers`);
  const values = rates.map(({ unitPrice: money }) => {
    const units = Number(money.units ?? "0");
    const nanos = money.nanos ?? 0;
    if (
      money.currencyCode !== "USD" ||
      !Number.isSafeInteger(units) ||
      !Number.isInteger(nanos) ||
      nanos < 0 ||
      nanos >= 1e9 ||
      units < 0
    ) {
      throw new Error(`SKU ${sku.skuId} has invalid USD money`);
    }
    return units + nanos / 1e9;
  });
  const price = values.at(-1)!;
  if (price <= 0 || values.some((value) => value !== 0 && value !== price)) {
    throw new Error(`SKU ${sku.skuId} has unsupported variable or zero pricing tiers`);
  }
  return price;
}

const DISKS: Record<string, string> = {
  hdd: "gce.storage.hdd",
  ssd: "gce.storage.ssd",
  balanced: "gce.storage.ssd.balanced",
  extreme: "gce.storage.ssd.extreme",
};
const BUCKETS: Record<string, string> = {
  standard: "storage.standard",
  nearline: "storage.nearline",
  coldline: "storage.coldline",
  archiv: "storage.archive",
};

export function machineComponents(
  name: string,
  machine: MachineDefinition,
): Array<[string, number]> {
  const family = name.split("-")[0];
  if (!["e2", "n2", "n2d", "c2", "c2d", "c3", "c4", "n4", "t2d", "a2"].includes(family)) {
    throw new Error(`Unsupported machine family ${family}`);
  }
  const suffix = family === "c2" ? "compute.optimized" : family;
  const components: Array<[string, number]> = [
    [`gce.compute.cpu.${suffix}`, machine.cpu],
    [`gce.compute.ram.${suffix}`, machine.ram],
  ];
  if (machine.a100) components.push(["gce.compute.gpu.a100", machine.a100]);
  if (machine["a100-80gb"]) components.push(["gce.compute.gpu.a100.80gb", machine["a100-80gb"]]);
  if (machine["local-ssd"]) components.push(["gce.storage.ssd.local", machine["local-ssd"] / 730]);
  if (components.some(([, quantity]) => !Number.isFinite(quantity) || quantity <= 0)) {
    throw new Error(`Invalid machine quantities for ${name}`);
  }
  return components;
}

export function requiredCatalogMappings(machines: Record<string, MachineDefinition>): Set<string> {
  return new Set([
    ...Object.entries(machines).flatMap(([name, machine]) =>
      machineComponents(name, machine).map(([id]) => id),
    ),
    ...Object.values(DISKS),
    ...Object.values(BUCKETS),
  ]);
}

export function assembleCatalog(
  skus: CatalogSku[],
  rules: MappingRule[],
  machines: Record<string, MachineDefinition>,
  regions: string[],
  now = Date.now(),
): Omit<CatalogDocument, "about" | "catalog"> {
  const required = requiredCatalogMappings(machines);
  const indexed = new Map<string, CatalogSku[]>();
  for (const sku of skus) {
    const mapping = catalogMapping(sku, rules);
    if (!mapping || !required.has(mapping)) continue;
    if (sku.category.usageType !== "OnDemand" || !Array.isArray(sku.serviceRegions)) {
      throw new Error(`Invalid on-demand SKU ${sku.skuId}`);
    }
    for (const region of sku.serviceRegions) {
      if (!regions.includes(region)) continue;
      const key = `${mapping}/${region}`;
      indexed.set(key, [...(indexed.get(key) ?? []), sku]);
    }
  }
  function rate(mapping: string, region: string): number | undefined {
    const candidates = indexed.get(`${mapping}/${region}`) ?? [];
    if (!candidates.length) return undefined;
    const unit = mapping.startsWith("gce.compute.ram.")
      ? "GiBy.h"
      : mapping.startsWith("gce.compute.")
        ? "h"
        : "GiBy.mo";
    const values = candidates.map((sku) => catalogRate(sku, unit, now));
    // gcosts permits duplicate Virginia descriptions. Make this deterministic
    // and require equal prices; other duplicate mappings remain errors.
    if (
      values.length > 1 &&
      (!candidates.every((sku) => sku.description.includes("Virginia")) ||
        values.some((p) => p !== values[0]))
    ) {
      throw new Error(
        `Ambiguous catalog mapping ${mapping} in ${region}: ${candidates.map((s) => s.skuId).join(",")}`,
      );
    }
    return values[0];
  }
  const result = {
    compute: {
      instance: {} as Record<string, CatalogEntry>,
      storage: {} as Record<string, CatalogEntry>,
    },
    storage: { bucket: {} as Record<string, CatalogEntry> },
  };
  for (const [name, machine] of Object.entries(machines)) {
    const entry: CatalogEntry = { cost: {} };
    for (const region of regions) {
      const components = machineComponents(name, machine);
      const prices = components.map(([mapping]) => rate(mapping, region));
      // Never quote CPU-only, GPU-less or local-SSD-less partial instances.
      if (prices.some((price) => price === undefined)) continue;
      entry.cost[region] = {
        hour: components.reduce((sum, [, quantity], i) => sum + quantity * prices[i]!, 0),
      };
    }
    if (!Object.keys(entry.cost).length) throw new Error(`No complete catalog prices for ${name}`);
    result.compute.instance[name] = entry;
  }
  for (const [mappings, section] of [
    [DISKS, result.compute.storage],
    [BUCKETS, result.storage.bucket],
  ] as const) {
    for (const [name, mapping] of Object.entries(mappings)) {
      const entry: CatalogEntry = { cost: {} };
      for (const region of regions) {
        const price = rate(mapping, region);
        if (price !== undefined) entry.cost[region] = { month: price };
      }
      if (!Object.keys(entry.cost).length) throw new Error(`No catalog prices for ${mapping}`);
      section[name] = entry;
    }
  }
  return result;
}

/** Fetch every page of both required services before returning any snapshot. */
export async function generateCatalog(
  apiKey: string,
  csv: string,
  machines: Record<string, MachineDefinition>,
  regions: string[],
): Promise<CatalogDocument> {
  if (!apiKey) throw new Error("GCP_PRICING_API_KEY is required; no stale snapshot fallback");
  const rules = parseCatalogMappings(csv);
  const required = requiredCatalogMappings(machines);
  const skus: CatalogSku[] = [];
  const sources: CatalogReceipt[] = [];
  const signal = AbortSignal.timeout(10 * 60_000);
  for (const service of ["6F81-5844-456A", "95FF-2EF5-5EA1"]) {
    const url = `${GCP_PRICING_SOURCE_URL}/${service}/skus`;
    const hash = createHash("sha256");
    const ids = new Set<string>();
    const tokens = new Set<string>();
    let token = "";
    let pages = 0;
    let vintage = Infinity;
    do {
      if (++pages > 300) throw new Error(`Catalog pagination exceeded limit for ${service}`);
      const query = new URLSearchParams({ currencyCode: "USD", pageSize: "1000" });
      if (token) query.set("pageToken", token);
      const response = await fetchWithRetry(
        `${url}?${query}`,
        {
          headers: { "x-goog-api-key": apiKey },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
        { allowedHosts: ["cloudbilling.googleapis.com"], maxResponseBytes: 16 * 1024 * 1024 },
      );
      if (!response.ok)
        throw new Error(
          `Catalog ${service} page ${pages}: HTTP ${response.status}; check API enablement and key restrictions`,
        );
      const body = await response.text();
      hash.update(`${Buffer.byteLength(body)}:`).update(body);
      const page = JSON.parse(body) as { skus?: CatalogSku[]; nextPageToken?: string };
      if (!Array.isArray(page.skus) || !page.skus.length)
        throw new Error(`Catalog ${service} returned an empty or malformed page`);
      for (const sku of page.skus) {
        if (typeof sku.skuId !== "string" || ids.has(sku.skuId))
          throw new Error(`Catalog ${service} returned a missing or duplicate SKU`);
        ids.add(sku.skuId);
        const mapping = catalogMapping(sku, rules);
        if (mapping && required.has(mapping)) {
          skus.push(sku);
          vintage = Math.min(vintage, Date.parse(sku.pricingInfo.at(-1)?.effectiveTime ?? ""));
        }
      }
      token = page.nextPageToken ?? "";
      if (typeof token !== "string" || (token && tokens.has(token)))
        throw new Error(`Catalog ${service} repeated or malformed pagination token`);
      if (token) tokens.add(token);
    } while (token);
    if (!Number.isFinite(vintage))
      throw new Error(`Catalog ${service} has no current mapped pricing`);
    sources.push({
      url,
      retrieved_at: new Date().toISOString(),
      sha256: hash.digest("hex"),
      source_vintage: new Date(vintage).toISOString(),
      pages,
      sku_count: ids.size,
    });
    console.log(`  Catalog ${service}: ${ids.size} SKUs, ${pages} complete pages`);
  }
  const tables = assembleCatalog(skus, rules, machines, regions);
  const generated = new Date().toISOString();
  return {
    about: { generated, timestamp: Date.parse(generated) / 1000 },
    ...tables,
    catalog: { sources, generator: "CloudCostMCP/gcp-catalog@1" },
  };
}
