import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import compute from "../../../data/gcp-pricing/compute-engine.json" with { type: "json" };
import multipliers from "../../../data/region-price-multipliers.json" with { type: "json" };
import { EC2_BASE_PRICES, RDS_BASE_PRICES } from "../../../src/pricing/aws/fallback-data.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  write: vi.fn(),
  spawn: vi.fn(() => ({ status: 0 })),
}));
vi.mock("fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeFileSync: mocks.write,
}));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("../../../src/pricing/fetch-utils.js", () => ({ fetchWithRetry: mocks.fetch }));

const gcp = {
  about: { timestamp: Date.parse("2026-10-01T12:00:00Z") / 1000 },
  compute: {
    instance: Object.fromEntries(
      Object.keys(compute["us-central1"]).map((sku) => [
        sku,
        {
          cost: Object.fromEntries(
            Object.keys(multipliers.gcp).map((region) => [region, { hour: 1 }]),
          ),
        },
      ]),
    ),
    storage: Object.fromEntries(
      ["hdd", "ssd", "balanced", "extreme"].map((sku) => [sku, { cost: {} }]),
    ),
  },
  storage: {
    bucket: Object.fromEntries(
      ["standard", "nearline", "coldline", "archiv"].map((sku) => [sku, { cost: {} }]),
    ),
  },
};

// Populate the same 37 regional sections without writing any repository files.
const regions = Object.keys(multipliers.gcp);
for (const section of [gcp.compute.storage, gcp.storage.bucket]) {
  for (const entry of Object.values(section)) {
    entry.cost = Object.fromEntries(regions.map((region) => [region, { month: 0.1 }]));
  }
}

function awsCsv(rds = false): string {
  const prices = rds ? RDS_BASE_PRICES : EC2_BASE_PRICES;
  return (
    '"Publication Date","2026-09-30T00:00:00Z"\n' +
    "SKU,Instance Type,Operating System,Tenancy,TermType,Capacity Status,Product Family,PricePerUnit,Database Engine,Deployment Option\n" +
    Object.entries(prices)
      .map(
        ([sku, price]) =>
          `sku,${sku},Linux,Shared,OnDemand,Used,Compute Instance,${price},PostgreSQL,Single-AZ\n`,
      )
      .join("")
  );
}

function writesFor(provider: string): Record<string, unknown>[] {
  return mocks.write.mock.calls
    .filter(([path]) => String(path).endsWith(`data/${provider}-pricing/metadata.json`))
    .map(([, body]) => JSON.parse(body));
}

async function run() {
  vi.resetModules();
  const saved = process.argv;
  process.argv = [...saved, "--write"];
  try {
    const script = await import("../../../scripts/refresh-pricing.js");
    await script.main();
  } finally {
    process.argv = saved;
  }
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.write.mockClear();
  mocks.spawn.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.includes("pricing.yml")) return new Response(stringify(gcp));
    if (url.includes("amazonaws.com")) return new Response(awsCsv(url.includes("AmazonRDS")));
    return new Response(
      JSON.stringify({
        Items: [
          {
            unitPrice: 0.1,
            productName: "Virtual Machines",
            skuName: "Linux",
            meterName: "Linux",
            effectiveStartDate: "2023-01-01T00:00:00Z",
          },
        ],
      }),
    );
  });
});
afterEach(() => {
  process.exitCode = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pricing refresh certification", () => {
  it("writes dates only after complete retrieval and validation, preserving source vintage", async () => {
    await run();
    const meta = writesFor("gcp")[0];
    expect(meta.last_updated).toBe("2026-10-01");
    expect(meta.last_verified).toBe("2026-10-07");
    expect(meta.verified_at).toBe("2026-10-07T12:00:00.000Z");
    const sources = meta.sources as Array<Record<string, string>>;
    expect(sources[0].source_vintage).toBe("2026-10-01");
    expect(sources[0].retrieved_at).toBe("2026-10-07T12:00:00.000Z");
    expect(sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(writesFor("aws")).toHaveLength(1);
    expect(writesFor("azure")).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });
  it.each(["stale", "future", "missing", "empty"])(
    "does not advance GCP metadata for %s source data",
    async (kind) => {
      const timestamp =
        kind === "stale" ? Date.parse("2026-08-01") / 1000 : Date.parse("2026-11-01") / 1000;
      const doc =
        kind === "empty"
          ? { about: gcp.about }
          : { ...gcp, about: kind === "missing" ? {} : { timestamp } };
      const original = mocks.fetch.getMockImplementation()!;
      mocks.fetch.mockImplementation((url: string) =>
        url.includes("pricing.yml") ? Promise.resolve(new Response(stringify(doc))) : original(url),
      );
      await run();
      expect(writesFor("gcp")).toHaveLength(0);
      expect(writesFor("aws")).toHaveLength(1);
      expect(writesFor("azure")).toHaveLength(1);
      expect(process.exitCode).toBe(1);
    },
  );
  it("does not certify a failed AWS stream after enough rows were already read", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation((url: string) => {
      if (!url.includes("AmazonEC2")) return original(url);
      let sent = false;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) {
                controller.enqueue(new TextEncoder().encode(awsCsv()));
                sent = true;
              } else controller.error(new Error("upstream disconnected after rows"));
            },
          }),
        ),
      );
    });
    await run();
    expect(writesFor("aws")).toHaveLength(0);
    expect(writesFor("gcp")).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });
  it("does not certify an unreachable Azure endpoint", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation((url: string) =>
      url.includes("azure.com") ? Promise.reject(new Error("unavailable")) : original(url),
    );
    await run();
    expect(writesFor("azure")).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });
  it("does not stamp a provider when fallback module validation fails", async () => {
    mocks.spawn.mockReturnValueOnce({ status: 1 });
    await expect(run()).rejects.toThrow();
    expect(writesFor("aws")).toHaveLength(0);
  });
});
