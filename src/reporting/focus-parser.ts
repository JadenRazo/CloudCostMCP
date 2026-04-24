/**
 * FOCUS (FinOps Open Cost and Usage Specification) billing export parser.
 *
 * Inverse of `focus-report.ts` — takes a CSV string or a JSON array of rows
 * and returns a normalised list of line items suitable for reconciling an
 * estimate against what the cloud provider actually billed.
 *
 * Security posture:
 *   - Byte / row caps are enforced before any tokenisation.
 *   - Row-level non-finite `EffectiveCost` produces a warning and skips the
 *     row rather than poisoning downstream totals (fail-closed).
 *   - Every user-controlled string echoed back through warnings or row
 *     output is passed through `sanitizeForMessage` so the MCP response is
 *     safe to feed into a downstream LLM.
 *   - Prototype-pollution keys on the JSON path are stripped via the same
 *     reviver used by `safeJsonParse`.
 *   - Zero outbound network — no node:http, node:https, or fetch imports.
 */
import { MAX_FOCUS_EXPORT_BYTES, MAX_FOCUS_ROWS } from "../schemas/bounded.js";
import { sanitizeForMessage } from "../util/sanitize.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FocusRow {
  resourceId: string;
  actualMonthly: number;
  service: string;
  region: string;
  currency: string;
  period: { start: string; end: string };
}

export interface FocusParseResult {
  rows: FocusRow[];
  currency: string;
  warnings: string[];
  ignoredColumns: string[];
}

export interface FocusParseOptions {
  maxRows?: number;
  maxBytes?: number;
  requiredColumns?: readonly string[];
}

export class FocusCurrencyMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`FOCUS currency mismatch: rows contain both "${expected}" and "${actual}"`);
    this.name = "FocusCurrencyMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

// ---------------------------------------------------------------------------
// FOCUS column contract (kept in-tree; Wave 5.3 will extract to a shared
// constant when the emitter and schema consumers converge).
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = [
  "ResourceId",
  "EffectiveCost",
  "Currency",
  "BillingPeriodStart",
  "BillingPeriodEnd",
] as const;

const KNOWN_COLUMNS = new Set<string>([
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
]);

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Strict numeric literal: optional sign, digits, optional fractional part,
// optional exponent. Used to guard `parseFloat` from silently coercing values
// like "0.01 USD", "1,234.56", or "1e308xx" — real billing exports sometimes
// carry trailing currency symbols or thousands-separators, and silent
// coercion would mask data-quality issues.
const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseFocusExport(
  input: string | unknown[],
  opts: FocusParseOptions = {},
): FocusParseResult {
  const maxBytes = opts.maxBytes ?? MAX_FOCUS_EXPORT_BYTES;
  const maxRows = opts.maxRows ?? MAX_FOCUS_ROWS;
  const required = opts.requiredColumns ?? REQUIRED_COLUMNS;

  if (typeof input === "string") {
    // `String.length` counts UTF-16 code units; for CJK or emoji payloads that
    // understates the on-the-wire byte count by up to 4x. Measure in UTF-8 to
    // match the name of `MAX_FOCUS_EXPORT_BYTES` and the Zod schema message.
    if (Buffer.byteLength(input, "utf8") > maxBytes) {
      throw new Error(`FOCUS export exceeds ${maxBytes} bytes`);
    }
    return parseFocusCsv(input, { maxRows, required });
  }

  if (Array.isArray(input)) {
    if (input.length > maxRows) {
      throw new Error(`FOCUS rows exceed ${maxRows}`);
    }
    return parseFocusJson(input, { required });
  }

  throw new Error("FOCUS export must be a CSV string or an array of rows");
}

// ---------------------------------------------------------------------------
// CSV path
// ---------------------------------------------------------------------------

interface InternalOpts {
  maxRows: number;
  required: readonly string[];
}

function parseFocusCsv(raw: string, opts: InternalOpts): FocusParseResult {
  // Strip BOM.
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rowsRaw = tokenizeCsv(text);
  if (rowsRaw.length === 0) {
    return emptyResult();
  }

  const header = rowsRaw[0]!;
  const headerIndex = new Map<string, number>();
  for (let i = 0; i < header.length; i += 1) {
    headerIndex.set(header[i]!, i);
  }

  const missing = opts.required.filter((c) => !headerIndex.has(c));
  if (missing.length > 0) {
    throw new Error(`FOCUS export missing required columns: ${missing.join(", ")}`);
  }

  const ignoredColumns: string[] = [];
  for (const col of header) {
    if (!KNOWN_COLUMNS.has(col)) {
      ignoredColumns.push(sanitizeForMessage(col, 128));
    }
  }

  const warnings: string[] = [];
  if (ignoredColumns.length > 0) {
    warnings.push(`ignored unknown columns: ${ignoredColumns.join(", ")}`);
  }

  const dataRowCount = rowsRaw.length - 1;
  if (dataRowCount > opts.maxRows) {
    throw new Error(`FOCUS rows exceed ${opts.maxRows}`);
  }

  const aggregated = new Map<string, FocusRow>();
  const duplicates = new Map<string, number>();
  let currency: string | null = null;

  for (let i = 1; i < rowsRaw.length; i += 1) {
    const fields = rowsRaw[i]!;
    if (fields.length !== header.length) {
      throw new Error(`FOCUS CSV row ${i} has ${fields.length} fields, expected ${header.length}`);
    }

    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      record[header[c]!] = fields[c]!;
    }

    const rowCurrency = (record.Currency ?? "").trim();
    if (!rowCurrency) {
      warnings.push(`row ${i}: missing Currency — skipped`);
      continue;
    }
    if (currency === null) {
      currency = rowCurrency;
    } else if (currency !== rowCurrency) {
      throw new FocusCurrencyMismatchError(currency, rowCurrency);
    }

    const rawCost = String(record.EffectiveCost ?? "").trim();
    if (!NUMERIC_RE.test(rawCost)) {
      warnings.push(
        `row ${i}: invalid EffectiveCost "${sanitizeForMessage(rawCost, 64)}" — skipped`,
      );
      continue;
    }
    const effective = parseFloat(rawCost);
    if (!Number.isFinite(effective)) {
      warnings.push(`row ${i}: non-finite EffectiveCost — skipped`);
      continue;
    }

    const resourceIdRaw = (record.ResourceId ?? "").trim();
    if (!resourceIdRaw) {
      warnings.push(`row ${i}: missing ResourceId — skipped`);
      continue;
    }
    const resourceId = sanitizeForMessage(resourceIdRaw, 256);

    const row: FocusRow = {
      resourceId,
      actualMonthly: effective,
      service: sanitizeForMessage(record.ServiceName ?? "", 128) || "Other",
      region: sanitizeForMessage(record.Region ?? "", 64) || "unknown",
      currency: rowCurrency,
      period: {
        start: sanitizeForMessage(record.BillingPeriodStart ?? "", 32),
        end: sanitizeForMessage(record.BillingPeriodEnd ?? "", 32),
      },
    };

    const existing = aggregated.get(resourceId);
    if (existing) {
      existing.actualMonthly += effective;
      duplicates.set(resourceId, (duplicates.get(resourceId) ?? 1) + 1);
    } else {
      aggregated.set(resourceId, row);
    }
  }

  for (const [id, count] of duplicates.entries()) {
    warnings.push(`aggregated ${count} rows for resource ${id}`);
  }

  return {
    rows: [...aggregated.values()],
    currency: currency ?? "USD",
    warnings,
    ignoredColumns,
  };
}

// ---------------------------------------------------------------------------
// JSON path
// ---------------------------------------------------------------------------

function parseFocusJson(
  input: readonly unknown[],
  opts: { required: readonly string[] },
): FocusParseResult {
  const warnings: string[] = [];
  const ignoredColumnsSet = new Set<string>();
  const aggregated = new Map<string, FocusRow>();
  const duplicates = new Map<string, number>();
  let currency: string | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const entry = input[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`row ${i}: not an object — skipped`);
      continue;
    }

    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      record[k] = v;
      if (!KNOWN_COLUMNS.has(k)) {
        ignoredColumnsSet.add(sanitizeForMessage(k, 128));
      }
    }

    const missing = opts.required.filter((c) => !(c in record));
    if (missing.length > 0) {
      throw new Error(`FOCUS export missing required columns: ${missing.join(", ")}`);
    }

    const rowCurrency = String(record.Currency ?? "").trim();
    if (!rowCurrency) {
      warnings.push(`row ${i}: missing Currency — skipped`);
      continue;
    }
    if (currency === null) {
      currency = rowCurrency;
    } else if (currency !== rowCurrency) {
      throw new FocusCurrencyMismatchError(currency, rowCurrency);
    }

    let effective: number;
    if (typeof record.EffectiveCost === "number") {
      effective = record.EffectiveCost;
    } else {
      const rawCost = String(record.EffectiveCost ?? "").trim();
      if (!NUMERIC_RE.test(rawCost)) {
        warnings.push(
          `row ${i}: invalid EffectiveCost "${sanitizeForMessage(rawCost, 64)}" — skipped`,
        );
        continue;
      }
      effective = parseFloat(rawCost);
    }
    if (!Number.isFinite(effective)) {
      warnings.push(`row ${i}: non-finite EffectiveCost — skipped`);
      continue;
    }

    const resourceIdRaw = String(record.ResourceId ?? "").trim();
    if (!resourceIdRaw) {
      warnings.push(`row ${i}: missing ResourceId — skipped`);
      continue;
    }
    const resourceId = sanitizeForMessage(resourceIdRaw, 256);

    const row: FocusRow = {
      resourceId,
      actualMonthly: effective,
      service: sanitizeForMessage(String(record.ServiceName ?? ""), 128) || "Other",
      region: sanitizeForMessage(String(record.Region ?? ""), 64) || "unknown",
      currency: rowCurrency,
      period: {
        start: sanitizeForMessage(String(record.BillingPeriodStart ?? ""), 32),
        end: sanitizeForMessage(String(record.BillingPeriodEnd ?? ""), 32),
      },
    };

    const existing = aggregated.get(resourceId);
    if (existing) {
      existing.actualMonthly += effective;
      duplicates.set(resourceId, (duplicates.get(resourceId) ?? 1) + 1);
    } else {
      aggregated.set(resourceId, row);
    }
  }

  const ignoredColumns = [...ignoredColumnsSet];
  if (ignoredColumns.length > 0) {
    warnings.unshift(`ignored unknown columns: ${ignoredColumns.join(", ")}`);
  }

  for (const [id, count] of duplicates.entries()) {
    warnings.push(`aggregated ${count} rows for resource ${id}`);
  }

  return {
    rows: [...aggregated.values()],
    currency: currency ?? "USD",
    warnings,
    ignoredColumns,
  };
}

// ---------------------------------------------------------------------------
// CSV tokenizer
//
// Single-pass scanner that handles:
//   - quoted fields with `""` escapes
//   - `\r\n` and `\n` row terminators
//   - embedded newlines inside quoted fields
//
// Rejects:
//   - bare `\r` outside quoted fields (CWE-93 row-injection vector)
//   - unterminated quoted fields
//
// Uses per-field char arrays joined once per field to stay linear; never
// concatenates strings inside the hot loop.
// ---------------------------------------------------------------------------

function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field: string[] = [];
  let inQuotes = false;
  const len = text.length;

  // Track whether the scanner has pushed any character to the current row.
  // Prevents a trailing newline from emitting a phantom empty row.
  let hasAnyContent = false;

  for (let i = 0; i < len; i += 1) {
    const ch = text.charCodeAt(i);

    if (inQuotes) {
      if (ch === 0x22 /* " */) {
        if (i + 1 < len && text.charCodeAt(i + 1) === 0x22) {
          field.push('"');
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field.push(text[i]!);
      }
      continue;
    }

    if (ch === 0x22 /* " */) {
      inQuotes = true;
      hasAnyContent = true;
      continue;
    }
    if (ch === 0x2c /* , */) {
      row.push(field.join(""));
      field = [];
      hasAnyContent = true;
      continue;
    }
    if (ch === 0x0a /* \n */) {
      row.push(field.join(""));
      field = [];
      rows.push(row);
      row = [];
      hasAnyContent = false;
      continue;
    }
    if (ch === 0x0d /* \r */) {
      if (i + 1 < len && text.charCodeAt(i + 1) === 0x0a) {
        row.push(field.join(""));
        field = [];
        rows.push(row);
        row = [];
        hasAnyContent = false;
        i += 1;
        continue;
      }
      throw new Error("FOCUS CSV contains bare carriage return");
    }

    field.push(text[i]!);
    hasAnyContent = true;
  }

  if (inQuotes) {
    throw new Error("FOCUS CSV has unterminated quoted field");
  }

  if (hasAnyContent || field.length > 0) {
    row.push(field.join(""));
    rows.push(row);
  }

  return rows;
}

function emptyResult(): FocusParseResult {
  return { rows: [], currency: "USD", warnings: [], ignoredColumns: [] };
}
