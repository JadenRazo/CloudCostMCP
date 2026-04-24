/**
 * Per-resource variance computation: estimate vs. billed (FOCUS-derived).
 *
 * Kept as a pure function so it is trivially unit-testable without MCP
 * plumbing, and so the `compare_actual` handler stays focused on wiring.
 *
 * Fail-closed posture: non-finite inputs are skipped and surfaced as
 * warnings; totals only accumulate finite numbers so a single bad row
 * cannot poison the whole response.
 */
import type { FocusRow } from "../reporting/focus-parser.js";
import { FocusCurrencyMismatchError } from "../reporting/focus-parser.js";
import { sanitizeForMessage } from "../util/sanitize.js";

export interface VarianceDriver {
  resource_id: string;
  estimated: number;
  actual: number;
  delta: number;
  pct: number;
}

export interface VarianceResult {
  total_estimated: number;
  total_actual: number;
  total_variance: number;
  pct: number;
  top_drivers: VarianceDriver[];
  missing_actuals: string[];
  extra_actuals: string[];
  warnings: string[];
}

export interface VarianceOptions {
  currency: string;
  maxDrivers?: number;
}

const DEFAULT_MAX_DRIVERS = 5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeVariance(
  estimates: ReadonlyArray<{ resource_id: string; monthly_cost: number }>,
  actuals: ReadonlyArray<FocusRow>,
  opts: VarianceOptions,
): VarianceResult {
  const warnings: string[] = [];
  const expectedCurrency = opts.currency;
  const maxDrivers = opts.maxDrivers ?? DEFAULT_MAX_DRIVERS;

  // Currency guard: every FOCUS row must match the expected comparison
  // currency exactly. The parser already rejects cross-row mismatches, so
  // this check is really "does the single uniform currency match what
  // compare_actual wants to report in".
  for (const a of actuals) {
    if (a.currency !== expectedCurrency) {
      throw new FocusCurrencyMismatchError(expectedCurrency, a.currency);
    }
  }

  const estimateMap = new Map<string, number>();
  for (const e of estimates) {
    if (!Number.isFinite(e.monthly_cost)) {
      warnings.push(`skipped non-finite estimate for ${sanitizeForMessage(e.resource_id, 256)}`);
      continue;
    }
    estimateMap.set(e.resource_id, e.monthly_cost);
  }

  const actualMap = new Map<string, number>();
  for (const a of actuals) {
    if (!Number.isFinite(a.actualMonthly)) {
      warnings.push(`skipped non-finite actual for ${sanitizeForMessage(a.resourceId, 256)}`);
      continue;
    }
    actualMap.set(a.resourceId, a.actualMonthly);
  }

  const drivers: VarianceDriver[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  let totalEstimated = 0;
  let totalActual = 0;

  for (const [id, estimated] of estimateMap.entries()) {
    const actual = actualMap.get(id);
    totalEstimated += estimated;
    if (actual === undefined) {
      missing.push(sanitizeForMessage(id, 256));
      continue;
    }
    totalActual += actual;
    const delta = actual - estimated;
    const pct = estimated !== 0 ? (delta / estimated) * 100 : actual === 0 ? 0 : 100;
    drivers.push({
      resource_id: sanitizeForMessage(id, 256),
      estimated: round2(estimated),
      actual: round2(actual),
      delta: round2(delta),
      pct: round1(pct),
    });
  }

  for (const [id, actual] of actualMap.entries()) {
    if (!estimateMap.has(id)) {
      extra.push(sanitizeForMessage(id, 256));
      totalActual += actual;
    }
  }

  drivers.sort((a, b) => {
    const diff = Math.abs(b.delta) - Math.abs(a.delta);
    if (diff !== 0) return diff;
    return a.resource_id.localeCompare(b.resource_id);
  });

  const topDrivers = drivers.slice(0, maxDrivers);

  const totalVariance = totalActual - totalEstimated;
  const pct =
    totalEstimated !== 0 ? (totalVariance / totalEstimated) * 100 : totalActual === 0 ? 0 : 100;

  missing.sort();
  extra.sort();

  return {
    total_estimated: round2(totalEstimated),
    total_actual: round2(totalActual),
    total_variance: round2(totalVariance),
    pct: round1(pct),
    top_drivers: topDrivers,
    missing_actuals: missing,
    extra_actuals: extra,
    warnings,
  };
}
