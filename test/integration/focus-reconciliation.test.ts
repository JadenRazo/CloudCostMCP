import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../src/pricing/cache.js";
import { PricingEngine } from "../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { compareActual } from "../../src/tools/compare-actual.js";
import { tempDbPath } from "../helpers/factories.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AWS_INSTANCE_STATE = {
  mode: "managed" as const,
  type: "aws_instance",
  name: "web",
  provider: 'provider["registry.terraform.io/hashicorp/aws"]',
  instances: [
    {
      attributes: {
        id: "i-12345",
        instance_type: "t3.micro",
        ami: "ami-12345",
        availability_zone: "us-east-1a",
        tags: { Name: "web" },
      },
    },
  ],
};

const AWS_EBS_STATE = {
  mode: "managed" as const,
  type: "aws_ebs_volume",
  name: "data",
  provider: 'provider["registry.terraform.io/hashicorp/aws"]',
  instances: [
    {
      attributes: {
        id: "vol-12345",
        size: 100,
        type: "gp3",
        availability_zone: "us-east-1a",
      },
    },
  ],
};

const SIMPLE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}

resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 100
  type              = "gp3"
}
`;

function makeStateJson(resources: Record<string, unknown>[] = []): string {
  return JSON.stringify({
    version: 4,
    terraform_version: "1.5.0",
    serial: 1,
    lineage: "test-123",
    resources,
  });
}

// FOCUS CSV covering a subset of headers; the parser requires only
// ResourceId/EffectiveCost/Currency/BillingPeriodStart/BillingPeriodEnd.
const FOCUS_HEADER =
  "BillingAccountId,BillingPeriodStart,BillingPeriodEnd,ChargeType,Provider,ServiceName,ServiceCategory,ResourceId,ResourceName,ResourceType,Region,PricingUnit,PricingQuantity,EffectiveCost,ListCost,ListUnitPrice,Currency";

function focusRow(
  resourceId: string,
  effectiveCost: number,
  currency = "USD",
  service = "Amazon EC2",
): string {
  return [
    "acct-1",
    "2026-04-01",
    "2026-05-01",
    "Usage",
    "aws",
    service,
    "Compute",
    resourceId,
    resourceId,
    "aws_instance",
    "us-east-1",
    "Hours",
    "730",
    effectiveCost.toFixed(4),
    effectiveCost.toFixed(4),
    "0.0137",
    currency,
  ].join(",");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("compareActual + FOCUS reconciliation", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-focus-recon");
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("populates actual_vs_estimate_variance when CSV FOCUS export is supplied", async () => {
    const focusCsv = [
      FOCUS_HEADER,
      focusRow("aws_instance.web", 999),
      focusRow("aws_ebs_volume.data", 15),
    ].join("\n");

    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE, AWS_EBS_STATE]),
        files: [{ path: "main.tf", content: SIMPLE_TF }],
        focus_export: focusCsv,
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.planned_costs).toBeDefined();
    expect(result.actual_vs_estimate_variance).toBeDefined();
    const variance = result.actual_vs_estimate_variance!;
    expect(variance.total_actual).toBeCloseTo(1014, 2);
    expect(variance.total_variance).toBeGreaterThan(0);
    expect(variance.top_drivers.length).toBeGreaterThan(0);
    expect(variance.top_drivers[0]!.resource_id).toBe("aws_instance.web");
  });

  it("accepts JSON row array form of focus_export", async () => {
    const focusRows = [
      {
        ResourceId: "aws_instance.web",
        EffectiveCost: 100,
        Currency: "USD",
        BillingPeriodStart: "2026-04-01",
        BillingPeriodEnd: "2026-05-01",
        ServiceName: "Amazon EC2",
        Region: "us-east-1",
      },
    ];
    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE]),
        files: [{ path: "main.tf", content: SIMPLE_TF }],
        focus_export: focusRows,
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.actual_vs_estimate_variance).toBeDefined();
    const variance = result.actual_vs_estimate_variance!;
    expect(variance.total_actual).toBe(100);
  });

  it("warns and skips variance when focus_export is supplied without files", async () => {
    const focusCsv = [FOCUS_HEADER, focusRow("aws_instance.web", 10)].join("\n");
    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE]),
        focus_export: focusCsv,
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );
    expect(result.actual_vs_estimate_variance).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("variance requires an estimate source"))).toBe(
      true,
    );
  });

  it("skips variance and warns on currency mismatch between export and report currency", async () => {
    const focusCsv = [FOCUS_HEADER, focusRow("aws_instance.web", 10, "EUR")].join("\n");
    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE]),
        files: [{ path: "main.tf", content: SIMPLE_TF }],
        focus_export: focusCsv,
        provider: "aws",
        region: "us-east-1",
        currency: "USD",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );
    expect(result.actual_vs_estimate_variance).toBeUndefined();
    expect(result.warnings.some((w) => /does not match report currency/.test(w))).toBe(true);
  });

  it("surfaces parser warnings in the tool response", async () => {
    const focusCsv = [
      FOCUS_HEADER,
      focusRow("aws_instance.web", 10),
      // Duplicate row triggers an aggregation warning.
      focusRow("aws_instance.web", 5),
    ].join("\n");

    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE]),
        files: [{ path: "main.tf", content: SIMPLE_TF }],
        focus_export: focusCsv,
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.actual_vs_estimate_variance).toBeDefined();
    expect(result.warnings.some((w) => /aggregated 2/.test(w))).toBe(true);
  });

  it("reports missing and extra actuals against the planned estimate", async () => {
    const focusCsv = [FOCUS_HEADER, focusRow("aws_instance.web", 20), focusRow("i-orphan", 5)].join(
      "\n",
    );
    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE, AWS_EBS_STATE]),
        files: [{ path: "main.tf", content: SIMPLE_TF }],
        focus_export: focusCsv,
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    const variance = result.actual_vs_estimate_variance!;
    expect(variance.missing_actuals).toContain("aws_ebs_volume.data");
    expect(variance.extra_actuals).toContain("i-orphan");
  });
});
