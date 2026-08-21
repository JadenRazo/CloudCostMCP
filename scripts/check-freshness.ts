#!/usr/bin/env tsx
/**
 * Fails when any bundled pricing dataset is older than the gate threshold.
 *
 * This lived as a `node - <<'SCRIPT'` heredoc inside .github/workflows/ci.yml.
 * A heredoc in YAML is invisible to the type checker, the linter, the test
 * suite and the coverage gate; it cannot be run locally without copying it out
 * of the file; and it carried its own private copy of the 21-day threshold that
 * nothing tied to the two thresholds in src/data/loader.ts. Both are now
 * imported from src/data/freshness.ts.
 *
 * Two callers, deliberately:
 *   - the scheduled freshness check, which answers "has the refresh loop
 *     stopped working?"
 *   - publish.yml, before `npm publish`, which answers "are we about to ship
 *     prices this old?". v1.2.1 shipped GCP data that was already four months
 *     stale, because nothing asked.
 *
 * Two dates, because one was doing the work of two:
 *
 *   last_updated   the vintage of the numbers themselves.
 *   last_verified  the last time the refresh loop completed for this provider.
 *
 * Both matter and they fail differently. A fresh `last_verified` over an
 * ancient `last_updated` means the loop is running but the source has frozen;
 * a fresh `last_updated` with no `last_verified` means nobody has checked since
 * whenever that number was written. Reporting one age for both is how a dead
 * GCP fetcher and an overdue hand-curation produced the same message for four
 * months.
 *
 * `curated_datasets` names files that no automation refreshes. They are
 * reported, not gated: they have never been tracked, and turning them into a
 * hard failure is a policy call rather than a bug fix. Naming them at least
 * makes the gap visible instead of letting the automated stamp imply a
 * freshness that was never checked.
 *
 * Usage:
 *   tsx scripts/check-freshness.ts [--max-age <days>] [--json]
 *
 * Exit 0 everything within the threshold, 1 something is stale, 2 the data
 * could not be read at all (a missing or unparseable file is never treated as
 * fresh).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CURATED_MAX_AGE_DAYS,
  GATE_MAX_AGE_DAYS,
  MS_PER_DAY,
  PRICING_PROVIDERS,
  type PricingProvider,
  type RefreshPolicy,
} from "../src/data/freshness.js";

interface Row {
  provider: PricingProvider;
  file: string;
  last_updated: string | null;
  last_verified: string | null;
  updated_age_days: number | null;
  verified_age_days: number | null;
  policy: RefreshPolicy;
  threshold_days: number;
  curated_datasets: string[];
  status: "ok" | "STALE" | "UNREADABLE";
  reason: string | null;
}

function parseArgs(argv: string[]): { maxAge: number; json: boolean } {
  let maxAge = GATE_MAX_AGE_DAYS;
  let json = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--max-age") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`error: --max-age must be a positive number, got ${String(raw)}\n`);
        process.exit(2);
      }
      maxAge = n;
    } else if (argv[i] === "--json") {
      json = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write("Usage: check-freshness.ts [--max-age <days>] [--json]\n");
      process.exit(0);
    } else {
      process.stderr.write(`error: unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }
  return { maxAge, json };
}

function ageDays(value: string | null, now: number): number | null {
  if (value === null) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return Math.max(0, Math.floor((now - at.getTime()) / MS_PER_DAY));
}

function readPolicy(raw: unknown): RefreshPolicy {
  return raw === "automated" || raw === "curated" ? raw : "unspecified";
}

function readCuratedDatasets(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

export function evaluateProvider(
  provider: PricingProvider,
  file: string,
  meta: Record<string, unknown>,
  maxAge: number,
  now: number,
): Row {
  const lastUpdated = typeof meta.last_updated === "string" ? meta.last_updated : null;
  const lastVerified = typeof meta.last_verified === "string" ? meta.last_verified : null;
  const policy = readPolicy(meta.refresh_policy);
  const curated = readCuratedDatasets(meta.curated_datasets);
  const updatedAge = ageDays(lastUpdated, now);
  const verifiedAge = ageDays(lastVerified, now);

  const threshold = policy === "curated" ? CURATED_MAX_AGE_DAYS : maxAge;

  const base: Omit<Row, "status" | "reason"> = {
    provider,
    file,
    last_updated: lastUpdated,
    last_verified: lastVerified,
    updated_age_days: updatedAge,
    verified_age_days: verifiedAge,
    policy,
    threshold_days: threshold,
    curated_datasets: curated,
  };

  // An unparseable or absent vintage is never treated as fresh.
  if (updatedAge === null) {
    return { ...base, status: "UNREADABLE", reason: "last_updated missing or unparseable" };
  }

  // Automated providers are held to both clocks. `last_verified` is optional so
  // that a metadata file written before 3.0.0 still evaluates rather than
  // failing as unreadable — it simply falls back to the single-date behaviour.
  if (policy === "automated" && verifiedAge !== null && verifiedAge > threshold) {
    return {
      ...base,
      status: "STALE",
      reason: `the refresh loop has not completed in ${verifiedAge}d (limit ${threshold}d)`,
    };
  }

  if (updatedAge > threshold) {
    const why =
      policy === "curated"
        ? `curation is overdue at ${updatedAge}d (limit ${threshold}d)`
        : `data vintage is ${updatedAge}d (limit ${threshold}d)`;
    return { ...base, status: "STALE", reason: why };
  }

  return { ...base, status: "ok", reason: null };
}

function main(): void {
  const { maxAge, json } = parseArgs(process.argv);
  const now = Date.now();
  const rows: Row[] = [];

  for (const provider of PRICING_PROVIDERS) {
    const file = path.posix.join("data", `${provider}-pricing`, "metadata.json");
    let meta: Record<string, unknown>;

    try {
      meta = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      rows.push({
        provider,
        file,
        last_updated: null,
        last_verified: null,
        updated_age_days: null,
        verified_age_days: null,
        policy: "unspecified",
        threshold_days: maxAge,
        curated_datasets: [],
        status: "UNREADABLE",
        reason: "metadata.json missing or unparseable",
      });
      process.stderr.write(`${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    rows.push(evaluateProvider(provider, file, meta, maxAge, now));
  }

  if (json) {
    process.stdout.write(JSON.stringify({ max_age_days: maxAge, providers: rows }, null, 2) + "\n");
  } else {
    process.stdout.write(`Pricing data freshness (gate: ${maxAge} days)\n\n`);
    for (const r of rows) {
      const updated = r.updated_age_days === null ? "?" : `${r.updated_age_days}d`;
      const verified = r.verified_age_days === null ? "-" : `${r.verified_age_days}d`;
      process.stdout.write(
        `  ${r.status.padEnd(10)} ${r.provider.padEnd(6)} ${(r.last_updated ?? "unknown").padEnd(12)} ` +
          `vintage=${updated.padEnd(6)} verified=${verified.padEnd(6)} refresh=${r.policy}\n`,
      );
    }

    const curated = rows.flatMap((r) =>
      r.curated_datasets.map((d) => ({ provider: r.provider, d })),
    );
    if (curated.length > 0) {
      process.stdout.write(
        `\n  Not covered by any refresh loop (reported, not gated):\n` +
          curated.map((c) => `    ${c.provider}  ${c.d}\n`).join(""),
      );
    }
    process.stdout.write("\n");
  }

  const unreadable = rows.filter((r) => r.status === "UNREADABLE");
  const stale = rows.filter((r) => r.status === "STALE");

  if (unreadable.length > 0) {
    process.stderr.write(
      `${unreadable.length} provider(s) have missing or unparseable metadata: ` +
        `${unreadable.map((r) => r.provider).join(", ")}.\n` +
        `Unknown vintage is never treated as fresh.\n`,
    );
    process.exit(2);
  }

  if (stale.length > 0) {
    process.stderr.write(
      `${stale.length} provider(s) failed the freshness gate:\n` +
        stale.map((r) => `  ${r.provider}: ${r.reason ?? "stale"}\n`).join("") +
        `\nA stale 'verified' age means the refresh loop has stopped working - check the\n` +
        `Refresh Pricing workflow. A stale 'vintage' age means the loop is running but the\n` +
        `source has frozen, or the dataset is curated and the curation is overdue. Either\n` +
        `way the fix is to refresh the data, not to raise the threshold.\n`,
    );
    process.exit(1);
  }
}

main();
