import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Isolate env + HOME for every test so parallel runs don't clobber each other
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "CLOUDCOST_CACHE_TTL",
  "CLOUDCOST_CACHE_PATH",
  "CLOUDCOST_LOG_LEVEL",
  "CLOUDCOST_MONTHLY_HOURS",
  "CLOUDCOST_INCLUDE_DATA_TRANSFER",
  "CLOUDCOST_PRICING_MODEL",
  "CLOUDCOST_RESOLVE_MODULES",
  "CLOUDCOST_BUDGET_MONTHLY",
  "CLOUDCOST_BUDGET_PER_RESOURCE",
  "CLOUDCOST_BUDGET_WARN_PCT",
  "CLOUDCOST_GUARDRAIL_MAX_MONTHLY",
  "CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE",
  "CLOUDCOST_GUARDRAIL_WARN_RATIO",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

async function freshLoadConfig() {
  // Re-import so the module picks up current env / homedir() state.
  vi.resetModules();
  const mod = await import("../../src/config.js");
  return mod.loadConfig();
}

describe("loadConfig", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = join(tmpdir(), `cloudcost-home-${randomUUID()}`);
    mkdirSync(fakeHome, { recursive: true });
    // Override homedir() by pointing HOME at a scratch dir.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // Windows-style, harmless on linux
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
    if (fakeHome && existsSync(fakeHome)) {
      rmSync(fakeHome, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Defaults (no env, no file)
  // -------------------------------------------------------------------------

  it("returns defaults when no env vars and no config file exist", async () => {
    const cfg = await freshLoadConfig();

    expect(cfg.cache.ttl_seconds).toBe(86400);
    expect(cfg.cache.db_path.endsWith("cache.db")).toBe(true);
    expect(cfg.pricing.monthly_hours).toBe(730);
    expect(cfg.pricing.default_currency).toBe("USD");
    expect(cfg.pricing.pricing_model).toBe("on-demand");
    expect(cfg.pricing.include_data_transfer).toBe(true);
    expect(cfg.logging.level).toBe("info");
    expect(cfg.parser.resolve_modules).toBe(true);
    expect(cfg.budget?.warn_percentage).toBe(80);
    expect(cfg.guardrail?.warn_ratio).toBe(0.8);
  });

  // -------------------------------------------------------------------------
  // File config
  // -------------------------------------------------------------------------

  it("merges values from ~/.cloudcost/config.json when present", async () => {
    const cfgDir = join(fakeHome, ".cloudcost");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({
        cache: { ttl_seconds: 1111, db_path: "/custom/path.db" },
        logging: { level: "debug" },
      }),
    );

    const cfg = await freshLoadConfig();

    expect(cfg.cache.ttl_seconds).toBe(1111);
    expect(cfg.cache.db_path).toBe("/custom/path.db");
    expect(cfg.logging.level).toBe("debug");
  });

  it("silently ignores an unparseable config.json", async () => {
    const cfgDir = join(fakeHome, ".cloudcost");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), "{ not valid json");

    const cfg = await freshLoadConfig();

    expect(cfg.cache.ttl_seconds).toBe(86400);
    expect(cfg.logging.level).toBe("info");
  });

  // -------------------------------------------------------------------------
  // Cache env
  // -------------------------------------------------------------------------

  it("parses CLOUDCOST_CACHE_TTL when numeric", async () => {
    process.env.CLOUDCOST_CACHE_TTL = "600";

    const cfg = await freshLoadConfig();
    expect(cfg.cache.ttl_seconds).toBe(600);
  });

  it("falls back to the default ttl when CLOUDCOST_CACHE_TTL is non-numeric", async () => {
    process.env.CLOUDCOST_CACHE_TTL = "not-a-number";
    process.env.CLOUDCOST_CACHE_PATH = "/tmp/custom-cache.db";

    const cfg = await freshLoadConfig();
    expect(cfg.cache.ttl_seconds).toBe(86400);
    expect(cfg.cache.db_path).toBe("/tmp/custom-cache.db");
  });

  it("honours CLOUDCOST_CACHE_PATH alone (ttl falls back to default)", async () => {
    process.env.CLOUDCOST_CACHE_PATH = "/tmp/only-path.db";

    const cfg = await freshLoadConfig();
    expect(cfg.cache.db_path).toBe("/tmp/only-path.db");
    expect(cfg.cache.ttl_seconds).toBe(86400);
  });

  // -------------------------------------------------------------------------
  // Logging env
  // -------------------------------------------------------------------------

  it("applies CLOUDCOST_LOG_LEVEL when set", async () => {
    process.env.CLOUDCOST_LOG_LEVEL = "warn";

    const cfg = await freshLoadConfig();
    expect(cfg.logging.level).toBe("warn");
  });

  // -------------------------------------------------------------------------
  // Pricing env
  // -------------------------------------------------------------------------

  it("parses CLOUDCOST_MONTHLY_HOURS", async () => {
    process.env.CLOUDCOST_MONTHLY_HOURS = "720";

    const cfg = await freshLoadConfig();
    expect(cfg.pricing.monthly_hours).toBe(720);
  });

  it("falls back to default monthly hours when value is non-numeric", async () => {
    process.env.CLOUDCOST_MONTHLY_HOURS = "garbage";
    process.env.CLOUDCOST_INCLUDE_DATA_TRANSFER = "true";

    const cfg = await freshLoadConfig();
    expect(cfg.pricing.monthly_hours).toBe(730);
  });

  it.each([
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["true", true],
    ["1", true],
    ["yes", true],
  ])("parses CLOUDCOST_INCLUDE_DATA_TRANSFER=%s as %s", async (raw, expected) => {
    process.env.CLOUDCOST_INCLUDE_DATA_TRANSFER = raw;
    const cfg = await freshLoadConfig();
    expect(cfg.pricing.include_data_transfer).toBe(expected);
  });

  it.each(["on-demand", "spot", "reserved-1yr", "reserved-3yr"] as const)(
    "accepts CLOUDCOST_PRICING_MODEL=%s",
    async (model) => {
      process.env.CLOUDCOST_PRICING_MODEL = model;
      const cfg = await freshLoadConfig();
      expect(cfg.pricing.pricing_model).toBe(model);
    },
  );

  it("rejects unknown CLOUDCOST_PRICING_MODEL and falls back to default", async () => {
    process.env.CLOUDCOST_PRICING_MODEL = "bogus-mode";

    const cfg = await freshLoadConfig();
    expect(cfg.pricing.pricing_model).toBe("on-demand");
  });

  // -------------------------------------------------------------------------
  // Parser env
  // -------------------------------------------------------------------------

  it.each([
    ["false", false],
    ["0", false],
    ["true", true],
    ["", true],
  ])("parses CLOUDCOST_RESOLVE_MODULES=%s as %s", async (raw, expected) => {
    process.env.CLOUDCOST_RESOLVE_MODULES = raw;
    const cfg = await freshLoadConfig();
    expect(cfg.parser.resolve_modules).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // Budget env
  // -------------------------------------------------------------------------

  it("applies all three budget env vars when set", async () => {
    process.env.CLOUDCOST_BUDGET_MONTHLY = "500";
    process.env.CLOUDCOST_BUDGET_PER_RESOURCE = "50";
    process.env.CLOUDCOST_BUDGET_WARN_PCT = "90";

    const cfg = await freshLoadConfig();
    expect(cfg.budget?.monthly_limit).toBe(500);
    expect(cfg.budget?.per_resource_limit).toBe(50);
    expect(cfg.budget?.warn_percentage).toBe(90);
  });

  it("drops NaN budget values rather than overriding defaults with NaN", async () => {
    process.env.CLOUDCOST_BUDGET_MONTHLY = "not-a-number";
    process.env.CLOUDCOST_BUDGET_PER_RESOURCE = "also-bad";
    process.env.CLOUDCOST_BUDGET_WARN_PCT = "NaN";

    const cfg = await freshLoadConfig();
    expect(cfg.budget?.monthly_limit).toBeUndefined();
    expect(cfg.budget?.per_resource_limit).toBeUndefined();
    // warn_percentage falls back to default (80).
    expect(cfg.budget?.warn_percentage).toBe(80);
  });

  it("applies CLOUDCOST_BUDGET_MONTHLY alone without wiping others", async () => {
    process.env.CLOUDCOST_BUDGET_MONTHLY = "250.5";

    const cfg = await freshLoadConfig();
    expect(cfg.budget?.monthly_limit).toBeCloseTo(250.5, 2);
    expect(cfg.budget?.warn_percentage).toBe(80); // still default
  });

  // -------------------------------------------------------------------------
  // Guardrail env
  // -------------------------------------------------------------------------

  it("applies guardrail env vars when positive + within bounds", async () => {
    process.env.CLOUDCOST_GUARDRAIL_MAX_MONTHLY = "10000";
    process.env.CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE = "500";
    process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO = "0.9";

    const cfg = await freshLoadConfig();
    expect(cfg.guardrail?.max_monthly).toBe(10000);
    expect(cfg.guardrail?.max_per_resource).toBe(500);
    expect(cfg.guardrail?.warn_ratio).toBe(0.9);
  });

  it("drops non-positive guardrail values", async () => {
    process.env.CLOUDCOST_GUARDRAIL_MAX_MONTHLY = "-5";
    process.env.CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE = "0";
    process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO = "0";

    const cfg = await freshLoadConfig();
    expect(cfg.guardrail?.max_monthly).toBeUndefined();
    expect(cfg.guardrail?.max_per_resource).toBeUndefined();
    // 0 is not within (0, 1], so fall back to default.
    expect(cfg.guardrail?.warn_ratio).toBe(0.8);
  });

  it("drops warn_ratio when > 1 (outside valid range)", async () => {
    process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO = "1.5";

    const cfg = await freshLoadConfig();
    expect(cfg.guardrail?.warn_ratio).toBe(0.8);
  });

  it("drops NaN guardrail values", async () => {
    process.env.CLOUDCOST_GUARDRAIL_MAX_MONTHLY = "totally-not-a-number";
    process.env.CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE = "nope";
    process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO = "xx";

    const cfg = await freshLoadConfig();
    expect(cfg.guardrail?.max_monthly).toBeUndefined();
    expect(cfg.guardrail?.max_per_resource).toBeUndefined();
    expect(cfg.guardrail?.warn_ratio).toBe(0.8);
  });

  it("accepts warn_ratio at the upper bound (1.0)", async () => {
    process.env.CLOUDCOST_GUARDRAIL_WARN_RATIO = "1";

    const cfg = await freshLoadConfig();
    expect(cfg.guardrail?.warn_ratio).toBe(1);
  });

  // -------------------------------------------------------------------------
  // File + env merging
  // -------------------------------------------------------------------------

  it("env overrides file when both set the same key", async () => {
    const cfgDir = join(fakeHome, ".cloudcost");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ cache: { ttl_seconds: 1111, db_path: "/file/path.db" } }),
    );
    process.env.CLOUDCOST_CACHE_TTL = "2222";

    const cfg = await freshLoadConfig();
    expect(cfg.cache.ttl_seconds).toBe(2222);
  });
});
