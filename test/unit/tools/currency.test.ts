import { describe, it, expect } from "vitest";
import {
  SUPPORTED_CURRENCIES,
  convertCurrency,
  formatCurrency,
  getCurrencySymbol,
  convertBreakdownCurrency,
} from "../../../src/currency.js";
import type { CostBreakdown } from "../../../src/types/pricing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    provider: "aws",
    region: "us-east-1",
    total_monthly: 100,
    total_yearly: 1200,
    currency: "USD",
    by_service: {
      compute: 70,
      block_storage: 30,
    },
    by_resource: [
      {
        resource_id: "res-1",
        resource_type: "aws_instance",
        resource_name: "web",
        provider: "aws",
        region: "us-east-1",
        monthly_cost: 70,
        yearly_cost: 840,
        currency: "USD",
        breakdown: [
          {
            description: "Compute hours",
            unit: "hours",
            quantity: 730,
            unit_price: 0.0958904,
            monthly_cost: 70,
          },
        ],
        confidence: "high",
        notes: [],
        pricing_source: "live",
      },
      {
        resource_id: "res-2",
        resource_type: "aws_ebs_volume",
        resource_name: "disk",
        provider: "aws",
        region: "us-east-1",
        monthly_cost: 30,
        yearly_cost: 360,
        currency: "USD",
        breakdown: [
          {
            description: "GB-Mo",
            unit: "GB-Mo",
            quantity: 375,
            unit_price: 0.08,
            monthly_cost: 30,
          },
        ],
        confidence: "high",
        notes: [],
        pricing_source: "live",
      },
    ],
    generated_at: new Date().toISOString(),
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SUPPORTED_CURRENCIES
// ---------------------------------------------------------------------------

describe("SUPPORTED_CURRENCIES", () => {
  it("contains exactly the expected currencies", () => {
    expect(SUPPORTED_CURRENCIES).toEqual(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "BRL"]);
  });
});

// ---------------------------------------------------------------------------
// convertCurrency
// ---------------------------------------------------------------------------

describe("convertCurrency", () => {
  it("returns the same amount for USD (no conversion needed)", () => {
    expect(convertCurrency(100, "USD")).toBe(100);
  });

  it("converts USD to EUR at ~0.92 rate", () => {
    expect(convertCurrency(100, "EUR")).toBeCloseTo(92, 1);
  });

  it("converts USD to GBP at ~0.79 rate", () => {
    expect(convertCurrency(100, "GBP")).toBeCloseTo(79, 1);
  });

  it("converts USD to JPY at ~149.50 rate", () => {
    expect(convertCurrency(100, "JPY")).toBeCloseTo(14950, 0);
  });

  it("converts USD to CAD at ~1.36 rate", () => {
    expect(convertCurrency(100, "CAD")).toBeCloseTo(136, 1);
  });

  it("converts USD to AUD at ~1.53 rate", () => {
    expect(convertCurrency(100, "AUD")).toBeCloseTo(153, 1);
  });

  it("converts USD to INR at ~83.10 rate", () => {
    expect(convertCurrency(100, "INR")).toBeCloseTo(8310, 0);
  });

  it("converts USD to BRL at ~4.97 rate", () => {
    expect(convertCurrency(100, "BRL")).toBeCloseTo(497, 1);
  });

  it("returns the original amount for an unknown currency", () => {
    expect(convertCurrency(50, "XYZ")).toBe(50);
  });

  it("handles zero amount correctly", () => {
    expect(convertCurrency(0, "EUR")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCurrencySymbol
// ---------------------------------------------------------------------------

describe("getCurrencySymbol", () => {
  it("returns $ for USD", () => expect(getCurrencySymbol("USD")).toBe("$"));
  it("returns € for EUR", () => expect(getCurrencySymbol("EUR")).toBe("€"));
  it("returns £ for GBP", () => expect(getCurrencySymbol("GBP")).toBe("£"));
  it("returns ¥ for JPY", () => expect(getCurrencySymbol("JPY")).toBe("¥"));
  it("returns CA$ for CAD", () => expect(getCurrencySymbol("CAD")).toBe("CA$"));
  it("returns A$ for AUD", () => expect(getCurrencySymbol("AUD")).toBe("A$"));
  it("returns ₹ for INR", () => expect(getCurrencySymbol("INR")).toBe("₹"));
  it("returns R$ for BRL", () => expect(getCurrencySymbol("BRL")).toBe("R$"));
  it("falls back to the currency code for unknown codes", () => {
    expect(getCurrencySymbol("XYZ")).toBe("XYZ");
  });
});

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------

describe("formatCurrency", () => {
  it("formats USD with 2 decimal places", () => {
    expect(formatCurrency(123.456, "USD")).toBe("$123.46");
  });

  it("formats EUR with 2 decimal places", () => {
    expect(formatCurrency(99.9, "EUR")).toBe("€99.90");
  });

  it("formats GBP with 2 decimal places", () => {
    expect(formatCurrency(50, "GBP")).toBe("£50.00");
  });

  it("formats JPY with 0 decimal places", () => {
    expect(formatCurrency(14950.7, "JPY")).toBe("¥14951");
  });

  it("formats INR with 2 decimal places", () => {
    expect(formatCurrency(8310.5, "INR")).toBe("₹8310.50");
  });

  it("formats BRL with 2 decimal places", () => {
    expect(formatCurrency(497, "BRL")).toBe("R$497.00");
  });

  it("formats zero correctly", () => {
    expect(formatCurrency(0, "USD")).toBe("$0.00");
    expect(formatCurrency(0, "JPY")).toBe("¥0");
  });
});

// ---------------------------------------------------------------------------
// convertBreakdownCurrency — USD passthrough
// ---------------------------------------------------------------------------

describe("convertBreakdownCurrency — USD", () => {
  it("does not alter amounts when currency is USD (rate=1)", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "USD");

    expect(result.total_monthly).toBe(100);
    expect(result.total_yearly).toBe(1200);
    expect(result.currency).toBe("USD");
    expect(result.original_usd.total_monthly).toBe(100);
    expect(result.original_usd.total_yearly).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// convertBreakdownCurrency — non-USD
// ---------------------------------------------------------------------------

describe("convertBreakdownCurrency — EUR conversion", () => {
  it("converts total_monthly and total_yearly", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "EUR");

    expect(result.total_monthly).toBeCloseTo(92, 1);
    expect(result.total_yearly).toBeCloseTo(1104, 1);
    expect(result.currency).toBe("EUR");
  });

  it("preserves original USD totals in original_usd", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "EUR");

    expect(result.original_usd.total_monthly).toBe(100);
    expect(result.original_usd.total_yearly).toBe(1200);
  });

  it("converts by_service amounts", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "EUR");

    expect(result.by_service["compute"]).toBeCloseTo(64.4, 1);
    expect(result.by_service["block_storage"]).toBeCloseTo(27.6, 1);
  });

  it("converts by_resource monthly_cost and yearly_cost", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "EUR");

    expect(result.by_resource[0].monthly_cost).toBeCloseTo(64.4, 1);
    expect(result.by_resource[0].yearly_cost).toBeCloseTo(772.8, 1);
    expect(result.by_resource[0].currency).toBe("EUR");
  });

  it("converts line item unit_price and monthly_cost", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "EUR");

    const lineItem = result.by_resource[0].breakdown[0];
    expect(lineItem.monthly_cost).toBeCloseTo(64.4, 1);
    // unit_price * 0.92
    expect(lineItem.unit_price).toBeCloseTo(0.0958904 * 0.92, 5);
    // quantity is not a cost field and must remain unchanged
    expect(lineItem.quantity).toBe(730);
  });
});

describe("convertBreakdownCurrency — JPY conversion", () => {
  it("converts totals using JPY rate", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "JPY");

    expect(result.total_monthly).toBeCloseTo(14950, 0);
    expect(result.total_yearly).toBeCloseTo(179400, 0);
    expect(result.currency).toBe("JPY");
  });

  it("preserves original USD totals", () => {
    const breakdown = makeBreakdown();
    const result = convertBreakdownCurrency(breakdown, "JPY");

    expect(result.original_usd.total_monthly).toBe(100);
    expect(result.original_usd.total_yearly).toBe(1200);
  });
});
