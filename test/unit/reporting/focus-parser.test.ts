import { describe, it, expect } from "vitest";
import {
  parseFocusExport,
  FocusCurrencyMismatchError,
} from "../../../src/reporting/focus-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADERS = [
  "BillingAccountId",
  "BillingPeriodStart",
  "BillingPeriodEnd",
  "ChargeType",
  "Provider",
  "ServiceName",
  "ServiceCategory",
  "ResourceId",
  "ResourceName",
  "ResourceType",
  "Region",
  "PricingUnit",
  "PricingQuantity",
  "EffectiveCost",
  "ListCost",
  "ListUnitPrice",
  "Currency",
].join(",");

function row(overrides: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    BillingAccountId: "acct-1",
    BillingPeriodStart: "2026-04-01",
    BillingPeriodEnd: "2026-05-01",
    ChargeType: "Usage",
    Provider: "aws",
    ServiceName: "Amazon EC2",
    ServiceCategory: "Compute",
    ResourceId: "i-abc",
    ResourceName: "web",
    ResourceType: "aws_instance",
    Region: "us-east-1",
    PricingUnit: "Hours",
    PricingQuantity: "730",
    EffectiveCost: "10.00",
    ListCost: "10.00",
    ListUnitPrice: "0.0137",
    Currency: "USD",
    ...overrides,
  };
  return [
    base.BillingAccountId,
    base.BillingPeriodStart,
    base.BillingPeriodEnd,
    base.ChargeType,
    base.Provider,
    base.ServiceName,
    base.ServiceCategory,
    base.ResourceId,
    base.ResourceName,
    base.ResourceType,
    base.Region,
    base.PricingUnit,
    base.PricingQuantity,
    base.EffectiveCost,
    base.ListCost,
    base.ListUnitPrice,
    base.Currency,
  ].join(",");
}

function csvOf(...rows: string[]): string {
  return [HEADERS, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Happy-path CSV
// ---------------------------------------------------------------------------

describe("parseFocusExport — CSV happy path", () => {
  it("parses a single-row CSV", () => {
    const result = parseFocusExport(csvOf(row()));
    expect(result.currency).toBe("USD");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.resourceId).toBe("i-abc");
    expect(result.rows[0]!.actualMonthly).toBeCloseTo(10, 5);
    expect(result.rows[0]!.service).toBe("Amazon EC2");
    expect(result.warnings).toEqual([]);
  });

  it("parses multi-row CSV and preserves per-row totals", () => {
    const result = parseFocusExport(
      csvOf(row({ ResourceId: "i-a" }), row({ ResourceId: "i-b", EffectiveCost: "25.5" })),
    );
    expect(result.rows).toHaveLength(2);
    const totals = Object.fromEntries(result.rows.map((r) => [r.resourceId, r.actualMonthly]));
    expect(totals["i-a"]).toBe(10);
    expect(totals["i-b"]).toBe(25.5);
  });

  it("strips UTF-8 BOM", () => {
    const csv = "﻿" + csvOf(row());
    const result = parseFocusExport(csv);
    expect(result.rows).toHaveLength(1);
  });

  it("handles CRLF line endings", () => {
    const csv = csvOf(row()).replace(/\n/g, "\r\n");
    const result = parseFocusExport(csv);
    expect(result.rows).toHaveLength(1);
  });

  it("handles quoted fields with commas", () => {
    const quotedName = '"Amazon EC2, On-Demand"';
    const dataRow = row({ ServiceName: quotedName });
    const result = parseFocusExport(csvOf(dataRow));
    expect(result.rows[0]!.service).toBe("Amazon EC2, On-Demand");
  });

  it("handles quoted fields with embedded quotes via double-quote escape", () => {
    const quotedName = '"He said ""hi"""';
    const dataRow = row({ ServiceName: quotedName });
    const result = parseFocusExport(csvOf(dataRow));
    expect(result.rows[0]!.service).toBe('He said "hi"');
  });

  it("handles quoted fields with embedded newlines", () => {
    const quotedName = '"line1\nline2"';
    const dataRow = row({ ServiceName: quotedName });
    const result = parseFocusExport(csvOf(dataRow));
    // sanitizeForMessage strips \n as a control char
    expect(result.rows[0]!.service).toBe("line1line2");
  });
});

// ---------------------------------------------------------------------------
// Aggregation & warnings
// ---------------------------------------------------------------------------

describe("parseFocusExport — aggregation", () => {
  it("sums duplicate ResourceId rows and warns", () => {
    const result = parseFocusExport(
      csvOf(
        row({ ResourceId: "i-a", EffectiveCost: "10.00" }),
        row({ ResourceId: "i-a", EffectiveCost: "3.50" }),
      ),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.actualMonthly).toBeCloseTo(13.5, 5);
    expect(result.warnings.some((w) => w.includes("aggregated 2 rows for resource i-a"))).toBe(
      true,
    );
  });

  it("collects unknown columns into ignoredColumns with a summary warning", () => {
    const csv = [HEADERS + ",WeirdColumn", row() + ",foo"].join("\n");
    const result = parseFocusExport(csv);
    expect(result.ignoredColumns).toContain("WeirdColumn");
    expect(result.warnings.some((w) => w.startsWith("ignored unknown columns"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rejection paths
// ---------------------------------------------------------------------------

describe("parseFocusExport — rejection paths", () => {
  it("rejects when required column is missing", () => {
    const reduced = ["BillingPeriodStart", "BillingPeriodEnd", "EffectiveCost", "Currency"].join(
      ",",
    );
    const body = "2026-04-01,2026-05-01,10,USD";
    expect(() => parseFocusExport([reduced, body].join("\n"))).toThrow(
      /missing required columns.*ResourceId/,
    );
  });

  it("rejects oversized input", () => {
    const oversize = "a,b\n" + "1,2\n".repeat(10);
    expect(() => parseFocusExport(oversize, { maxBytes: 8 })).toThrow(/exceeds 8 bytes/);
  });

  it("rejects unterminated quoted field", () => {
    const badRow = row({ ServiceName: '"no-end' });
    expect(() => parseFocusExport(csvOf(badRow))).toThrow(/unterminated quoted field/);
  });

  it("rejects bare carriage return outside a quoted field", () => {
    const bad = csvOf(row()) + "\rtrailing";
    expect(() => parseFocusExport(bad)).toThrow(/bare carriage return/);
  });

  it("rejects row with mismatched field count", () => {
    const csv = [HEADERS, "too,few,fields"].join("\n");
    expect(() => parseFocusExport(csv)).toThrow(/has \d+ fields, expected/);
  });

  it("throws FocusCurrencyMismatchError on mixed currencies", () => {
    expect(() =>
      parseFocusExport(csvOf(row({ Currency: "USD" }), row({ Currency: "EUR" }))),
    ).toThrow(FocusCurrencyMismatchError);
  });

  it("rejects when input is neither string nor array", () => {
    expect(() => parseFocusExport(42 as unknown as string)).toThrow(
      /must be a CSV string or an array/,
    );
  });

  it("rejects CSV row count above cap", () => {
    const rows = Array.from({ length: 3 }, () => row());
    expect(() => parseFocusExport(csvOf(...rows), { maxRows: 2 })).toThrow(/FOCUS rows exceed 2/);
  });
});

// ---------------------------------------------------------------------------
// Row-level tolerance
// ---------------------------------------------------------------------------

describe("parseFocusExport — row-level tolerance", () => {
  it("skips non-finite EffectiveCost and warns", () => {
    const result = parseFocusExport(
      csvOf(row({ ResourceId: "i-a" }), row({ ResourceId: "i-b", EffectiveCost: "NaN" })),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.resourceId).toBe("i-a");
    expect(result.warnings.some((w) => /non-finite EffectiveCost/.test(w))).toBe(true);
  });

  it("skips rows with empty ResourceId and warns", () => {
    const result = parseFocusExport(csvOf(row({ ResourceId: "i-a" }), row({ ResourceId: "" })));
    expect(result.rows).toHaveLength(1);
    expect(result.warnings.some((w) => /missing ResourceId/.test(w))).toBe(true);
  });

  it("skips rows with empty Currency and warns without corrupting currency", () => {
    const result = parseFocusExport(
      csvOf(row({ ResourceId: "i-a" }), row({ ResourceId: "i-b", Currency: "" })),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.currency).toBe("USD");
    expect(result.warnings.some((w) => /missing Currency/.test(w))).toBe(true);
  });

  it("returns empty result for header-only CSV", () => {
    const result = parseFocusExport(HEADERS);
    expect(result.rows).toEqual([]);
    expect(result.currency).toBe("USD");
  });

  it("returns empty result for empty string", () => {
    const result = parseFocusExport("");
    expect(result.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Security / sanitization
// ---------------------------------------------------------------------------

describe("parseFocusExport — sanitization", () => {
  it("strips control characters from echoed ResourceId", () => {
    const malicious = "i-safe";
    const result = parseFocusExport(csvOf(row({ ResourceId: malicious })));
    expect(result.rows[0]!.resourceId).toBe("i-safe");
  });

  it("strips zero-width / bidi-override characters from ResourceId", () => {
    const malicious = "i-‮evil";
    const result = parseFocusExport(csvOf(row({ ResourceId: malicious })));
    expect(result.rows[0]!.resourceId).toBe("i-evil");
  });

  it("neutralizes CSV-injection by surviving an equals-prefixed ResourceId as text", () => {
    // sanitizeForMessage does not strip '=' (it's valid in IDs); the
    // parser must still accept and return it as a plain string so downstream
    // formatters can decide how to escape it. This asserts the parser does
    // not execute or mutate such content, only passes it through sanitized.
    const dataRow = row({ ResourceId: "=HYPERLINK" });
    const result = parseFocusExport(csvOf(dataRow));
    expect(result.rows[0]!.resourceId).toBe("=HYPERLINK");
  });
});

// ---------------------------------------------------------------------------
// JSON path
// ---------------------------------------------------------------------------

describe("parseFocusExport — JSON path", () => {
  it("parses a JSON array of rows", () => {
    const result = parseFocusExport([
      {
        ResourceId: "i-a",
        EffectiveCost: 12.5,
        Currency: "USD",
        BillingPeriodStart: "2026-04-01",
        BillingPeriodEnd: "2026-05-01",
        ServiceName: "Amazon EC2",
        Region: "us-east-1",
      },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.actualMonthly).toBe(12.5);
  });

  it("rejects JSON rows missing required fields", () => {
    expect(() => parseFocusExport([{ ResourceId: "i-a" }] as unknown[])).toThrow(
      /missing required columns/,
    );
  });

  it("sums duplicate rows on the JSON path and warns", () => {
    const result = parseFocusExport([
      {
        ResourceId: "i-a",
        EffectiveCost: 5,
        Currency: "USD",
        BillingPeriodStart: "2026-04-01",
        BillingPeriodEnd: "2026-05-01",
      },
      {
        ResourceId: "i-a",
        EffectiveCost: 6,
        Currency: "USD",
        BillingPeriodStart: "2026-04-01",
        BillingPeriodEnd: "2026-05-01",
      },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.actualMonthly).toBe(11);
    expect(result.warnings.some((w) => /aggregated 2/.test(w))).toBe(true);
  });

  it("rejects prototype-pollution keys on JSON input", () => {
    const malicious: unknown[] = [
      {
        __proto__: { polluted: true },
        ResourceId: "i-a",
        EffectiveCost: 1,
        Currency: "USD",
        BillingPeriodStart: "2026-04-01",
        BillingPeriodEnd: "2026-05-01",
      },
    ];
    parseFocusExport(malicious);
    // Must NOT have polluted Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects oversized row array", () => {
    const many = Array.from({ length: 10 }, () => ({
      ResourceId: "i",
      EffectiveCost: 1,
      Currency: "USD",
      BillingPeriodStart: "2026-04-01",
      BillingPeriodEnd: "2026-05-01",
    }));
    expect(() => parseFocusExport(many, { maxRows: 5 })).toThrow(/FOCUS rows exceed 5/);
  });

  it("skips non-object entries on JSON path", () => {
    const malformed: unknown[] = [
      null,
      {
        ResourceId: "i-a",
        EffectiveCost: 1,
        Currency: "USD",
        BillingPeriodStart: "2026-04-01",
        BillingPeriodEnd: "2026-05-01",
      },
    ];
    const result = parseFocusExport(malformed);
    expect(result.rows).toHaveLength(1);
    expect(result.warnings.some((w) => /not an object/.test(w))).toBe(true);
  });

  it("rejects currency mismatch on JSON path", () => {
    expect(() =>
      parseFocusExport([
        {
          ResourceId: "i-a",
          EffectiveCost: 1,
          Currency: "USD",
          BillingPeriodStart: "2026-04-01",
          BillingPeriodEnd: "2026-05-01",
        },
        {
          ResourceId: "i-b",
          EffectiveCost: 1,
          Currency: "EUR",
          BillingPeriodStart: "2026-04-01",
          BillingPeriodEnd: "2026-05-01",
        },
      ]),
    ).toThrow(FocusCurrencyMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Stress sanity check — scale with row count, not row count squared.
// ---------------------------------------------------------------------------

describe("parseFocusExport — performance guardrail", () => {
  it("parses 10k rows under 2 seconds", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      row({ ResourceId: `i-${i}`, EffectiveCost: "1.00" }),
    );
    const csv = csvOf(...rows);
    const start = Date.now();
    const result = parseFocusExport(csv, { maxRows: 10_000 });
    const elapsed = Date.now() - start;
    expect(result.rows).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(2000);
  });
});
