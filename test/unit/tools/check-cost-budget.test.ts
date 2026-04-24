import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG, type CloudCostConfig } from "../../../src/types/config.js";
import { checkCostBudget, checkCostBudgetSchema } from "../../../src/tools/check-cost-budget.js";
import { tempDbPath } from "../../helpers/factories.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHEAP_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}
`;

const MIXED_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}

resource "aws_instance" "api" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "m5.large"
}
`;

const EXPENSIVE_GPU_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "ml_cluster_node_1" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "p4d.24xlarge"
}

resource "aws_instance" "ml_cluster_node_2" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "p4d.24xlarge"
}
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("checkCostBudget", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;
  let config: CloudCostConfig;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-guardrail-test");
    cache = new PricingCache(dbPath);
    config = { ...DEFAULT_CONFIG, cache: { ...DEFAULT_CONFIG.cache, db_path: dbPath } };
    pricingEngine = new PricingEngine(cache, config);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Verdict logic
  // -------------------------------------------------------------------------

  it("returns allow with a hint when no thresholds are configured", async () => {
    const result = await checkCostBudget(
      { files: [{ path: "main.tf", content: CHEAP_TF }], provider: "aws" },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("allow");
    expect(result.thresholds.source.max_monthly).toBe("none");
    expect(result.thresholds.source.max_per_resource).toBe("none");
    expect(result.reasons[0]).toMatch(/no budget thresholds configured/i);
    expect(result.blocking_resources).toHaveLength(0);
    expect(result.warning_resources).toHaveLength(0);
  });

  it("returns allow when total is well under the aggregate threshold", async () => {
    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: CHEAP_TF }],
        provider: "aws",
        max_monthly: 100_000,
      },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("allow");
    expect(result.total_monthly).toBeLessThan(100_000);
    expect(result.blocking_resources).toHaveLength(0);
  });

  it("returns block when total exceeds the aggregate threshold", async () => {
    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: EXPENSIVE_GPU_TF }],
        provider: "aws",
        max_monthly: 100,
      },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("block");
    expect(result.reasons.some((r) => /total.*exceeds threshold/i.test(r))).toBe(true);
  });

  it("returns warn when total is in [warn_ratio, 1] of the aggregate threshold", async () => {
    // Price the CHEAP_TF fixture first to learn its monthly cost
    const probe = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: CHEAP_TF }],
        provider: "aws",
        max_monthly: 10_000,
      },
      pricingEngine,
      config,
    );
    const total = probe.total_monthly;
    // Set a threshold that puts total in the warn band [0.8, 1.0) * threshold
    const threshold = total / 0.9;

    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: CHEAP_TF }],
        provider: "aws",
        max_monthly: threshold,
        warn_ratio: 0.8,
      },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("warn");
    expect(result.reasons.some((r) => /is \d+% of threshold/.test(r))).toBe(true);
  });

  it("returns block when a single resource exceeds the per-resource threshold", async () => {
    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: EXPENSIVE_GPU_TF }],
        provider: "aws",
        max_per_resource: 50, // a GPU instance obviously costs more than $50/mo
      },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("block");
    expect(result.blocking_resources.length).toBeGreaterThan(0);
    const first = result.blocking_resources[0];
    expect(first.monthly_cost).toBeGreaterThan(first.threshold);
    expect(first.reason).toMatch(/exceeds per-resource limit/);
  });

  it("returns warn when a resource is in the per-resource warn band", async () => {
    // Probe: force the most expensive resource into the blocking bucket so we
    // can read its actual monthly cost out of the response.
    const probe = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: MIXED_TF }],
        provider: "aws",
        max_per_resource: 0.01,
      },
      pricingEngine,
      config,
    );
    const maxResource = Math.max(...probe.blocking_resources.map((r) => r.monthly_cost));
    expect(maxResource).toBeGreaterThan(0);

    // Set a threshold that puts the priciest resource at ~90% of the limit
    // — inside the warn band [0.8 * T, 1.0 * T).
    const perResourceThreshold = maxResource / 0.9;

    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: MIXED_TF }],
        provider: "aws",
        max_per_resource: perResourceThreshold,
        warn_ratio: 0.8,
      },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("warn");
    expect(result.warning_resources.length).toBeGreaterThan(0);
    expect(result.blocking_resources).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Threshold cascade
  // -------------------------------------------------------------------------

  it("uses params thresholds when present (params > config.guardrail > config.budget)", async () => {
    const configWithAll: CloudCostConfig = {
      ...config,
      guardrail: { max_monthly: 999, max_per_resource: 999, warn_ratio: 0.8 },
      budget: { monthly_limit: 1, per_resource_limit: 1, warn_percentage: 80 },
    };

    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: CHEAP_TF }],
        provider: "aws",
        max_monthly: 1_000_000,
      },
      pricingEngine,
      configWithAll,
    );

    expect(result.thresholds.source.max_monthly).toBe("params");
    // max_per_resource wasn't in params, so it should report its real origin
    expect(result.thresholds.source.max_per_resource).toBe("config");
    expect(result.thresholds.max_monthly).toBe(1_000_000);
    expect(result.thresholds.max_per_resource).toBe(999);
  });

  it("falls back to config.guardrail when params absent", async () => {
    const configWithGuardrail: CloudCostConfig = {
      ...config,
      guardrail: { max_monthly: 1_000_000, warn_ratio: 0.8 },
    };

    const result = await checkCostBudget(
      { files: [{ path: "main.tf", content: CHEAP_TF }], provider: "aws" },
      pricingEngine,
      configWithGuardrail,
    );

    expect(result.thresholds.source.max_monthly).toBe("config");
    expect(result.thresholds.source.max_per_resource).toBe("none");
    expect(result.thresholds.max_monthly).toBe(1_000_000);
  });

  it("falls back to config.budget as last resort", async () => {
    const configWithBudget: CloudCostConfig = {
      ...config,
      budget: { monthly_limit: 1_000_000, per_resource_limit: 500_000, warn_percentage: 80 },
    };

    const result = await checkCostBudget(
      { files: [{ path: "main.tf", content: CHEAP_TF }], provider: "aws" },
      pricingEngine,
      configWithBudget,
    );

    expect(result.thresholds.source.max_monthly).toBe("budget");
    expect(result.thresholds.source.max_per_resource).toBe("budget");
    expect(result.thresholds.max_monthly).toBe(1_000_000);
    expect(result.thresholds.max_per_resource).toBe(500_000);
  });

  // -------------------------------------------------------------------------
  // Output shape
  // -------------------------------------------------------------------------

  it("returns a structured summary suitable for an agent to surface", async () => {
    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: EXPENSIVE_GPU_TF }],
        provider: "aws",
        max_monthly: 1000,
      },
      pricingEngine,
      config,
    );

    expect(result.summary).toMatch(/^(allow|warn|block):/);
    expect(result.summary).toContain("/mo");
    expect(result.summary).toMatch(/\d+ resources?/);
    expect(result.currency).toBe("USD");
    // Two aws_instance blocks; some providers emit implicit attached resources
    // (root EBS volume), so assert >= 2 rather than exact.
    expect(result.resource_count).toBeGreaterThanOrEqual(2);
  });

  it("emits currency in the requested unit", async () => {
    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: CHEAP_TF }],
        provider: "aws",
        max_monthly: 100_000,
        currency: "EUR",
      },
      pricingEngine,
      config,
    );

    expect(result.currency).toBe("EUR");
    expect(result.summary).toContain("EUR");
  });

  // -------------------------------------------------------------------------
  // Provider / region inference
  // -------------------------------------------------------------------------

  it("infers provider from the parsed inventory when params.provider is absent", async () => {
    const result = await checkCostBudget(
      { files: [{ path: "main.tf", content: CHEAP_TF }], max_monthly: 100_000 },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("allow");
    expect(result.resource_count).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Defense-in-depth: error paths
  // -------------------------------------------------------------------------

  // Note: `parseTerraform` currently defaults an unknown provider to "aws"
  // (src/parsers/index.ts:109), so the `provider_unresolved` error path is
  // defense-in-depth rather than a reachable branch today. If the parser is
  // ever tightened to return `undefined`, the guard fires correctly.

  it("rejects a request whose aggregate file content exceeds the cap", () => {
    // 11 files × ~5 MiB each = ~55 MiB, over the 50 MiB aggregate cap
    const oneFile = "a".repeat(5 * 1024 * 1024);
    const oversize = Array.from({ length: 11 }, (_, i) => ({
      path: `f${i}.tf`,
      content: oneFile,
    }));

    const parseResult = checkCostBudgetSchema.safeParse({
      files: oversize,
      provider: "aws",
      max_monthly: 1000,
    });

    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      const msg = parseResult.error.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/aggregate file content exceeds/i);
    }
  });

  it("sanitises user-supplied resource identifiers in the output", async () => {
    // A resource name containing zero-width chars + bidi override — the kind
    // of payload a malicious IaC file could smuggle through to an LLM.
    const injected = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "evil‮_rotated" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "p4d.24xlarge"
}
`;
    const result = await checkCostBudget(
      {
        files: [{ path: "main.tf", content: injected }],
        provider: "aws",
        max_per_resource: 10,
      },
      pricingEngine,
      config,
    );

    expect(result.verdict).toBe("block");
    const anyVerdict = [...result.blocking_resources, ...result.warning_resources];
    expect(anyVerdict.length).toBeGreaterThan(0);
    // Bidi overrides (U+202A-U+202E) and zero-width chars (U+200B-U+200F)
    // must not survive into the response that reaches the LLM.
    const hasInvisible = (s: string) =>
      [...s].some((ch) => {
        const cp = ch.codePointAt(0) ?? 0;
        return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e);
      });
    for (const v of anyVerdict) {
      expect(hasInvisible(v.resource_id)).toBe(false);
      expect(hasInvisible(v.resource_type)).toBe(false);
    }
  });

  it("env parsing rejects negative and zero guardrail thresholds", async () => {
    const { loadConfig } = await import("../../../src/config.js");
    const prevMonthly = process.env.CLOUDCOST_GUARDRAIL_MAX_MONTHLY;
    const prevPer = process.env.CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE;
    const prevRatio = process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO;
    try {
      process.env.CLOUDCOST_GUARDRAIL_MAX_MONTHLY = "-1000";
      process.env.CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE = "0";
      process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO = "2";
      const cfg = loadConfig();
      expect(cfg.guardrail?.max_monthly).toBeUndefined();
      expect(cfg.guardrail?.max_per_resource).toBeUndefined();
      // Invalid warn_ratio falls back to the default (0.8)
      expect(cfg.guardrail?.warn_ratio).toBe(0.8);
    } finally {
      if (prevMonthly === undefined) delete process.env.CLOUDCOST_GUARDRAIL_MAX_MONTHLY;
      else process.env.CLOUDCOST_GUARDRAIL_MAX_MONTHLY = prevMonthly;
      if (prevPer === undefined) delete process.env.CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE;
      else process.env.CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE = prevPer;
      if (prevRatio === undefined) delete process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO;
      else process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO = prevRatio;
    }
  });
});
