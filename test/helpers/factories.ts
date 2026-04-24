/**
 * Shared test factories and utilities.
 *
 * Centralises the makeResource / makeEstimate / makeBreakdown / makeComparison
 * helpers and the tempDbPath utility that were previously duplicated across
 * 30+ test files.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ParsedResource } from "../../src/types/resources.js";
import type { CostEstimate, CostBreakdown, ProviderComparison } from "../../src/types/pricing.js";

// ---------------------------------------------------------------------------
// Resource factory
// ---------------------------------------------------------------------------

export function makeResource(overrides: Partial<ParsedResource> = {}): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_instance",
    name: "test-instance",
    provider: "aws",
    region: "us-east-1",
    attributes: { instance_type: "t3.large" },
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cost estimate factory
// ---------------------------------------------------------------------------

export function makeEstimate(overrides: Partial<CostEstimate> = {}): CostEstimate {
  return {
    resource_id: "test-resource",
    resource_type: "aws_instance",
    resource_name: "test-instance",
    provider: "aws",
    region: "us-east-1",
    monthly_cost: 60.74,
    yearly_cost: 728.88,
    currency: "USD",
    breakdown: [
      {
        description: "Compute",
        unit: "Hrs",
        quantity: 730,
        unit_price: 0.0832,
        monthly_cost: 60.74,
      },
    ],
    confidence: "high",
    notes: [],
    pricing_source: "fallback",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cost breakdown factory
// ---------------------------------------------------------------------------

export function makeBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    provider: "aws",
    region: "us-east-1",
    total_monthly: 60.74,
    total_yearly: 728.88,
    currency: "USD",
    by_service: { compute: 60.74 },
    by_resource: [makeEstimate()],
    generated_at: new Date().toISOString(),
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Provider comparison factory
// ---------------------------------------------------------------------------

export function makeComparison(overrides: Partial<ProviderComparison> = {}): ProviderComparison {
  const breakdown = makeBreakdown();
  return {
    source_provider: "aws",
    comparisons: [breakdown],
    savings_summary: [
      {
        provider: "aws",
        total_monthly: 60.74,
        difference_from_source: 0,
        percentage_difference: 0,
      },
    ],
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp database path
// ---------------------------------------------------------------------------

export function tempDbPath(prefix = "cloudcost-test"): string {
  const suffix = randomUUID();
  return join(tmpdir(), `${prefix}-${suffix}`, "cache.db");
}
