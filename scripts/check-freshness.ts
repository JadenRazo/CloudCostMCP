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
  GATE_MAX_AGE_DAYS,
  MS_PER_DAY,
  PRICING_PROVIDERS,
  type PricingProvider,
} from "../src/data/freshness.js";

interface Row {
  provider: PricingProvider;
  file: string;
  last_updated: string | null;
  age_days: number | null;
  policy: string;
  status: "ok" | "STALE" | "UNREADABLE";
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
        age_days: null,
        policy: "unknown",
        status: "UNREADABLE",
      });
      process.stderr.write(`${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    const lastUpdated = typeof meta.last_updated === "string" ? meta.last_updated : null;
    // Declared by the refresh script for providers it maintains. Absent means
    // unknown, which is reported rather than assumed.
    const policy = typeof meta.refresh_policy === "string" ? meta.refresh_policy : "unspecified";
    const asOf = lastUpdated !== null ? new Date(lastUpdated) : null;

    if (asOf === null || Number.isNaN(asOf.getTime())) {
      rows.push({ provider, file, last_updated: lastUpdated, age_days: null, policy, status: "UNREADABLE" });
      continue;
    }

    const ageDays = Math.max(0, Math.floor((now - asOf.getTime()) / MS_PER_DAY));
    rows.push({
      provider,
      file,
      last_updated: lastUpdated,
      age_days: ageDays,
      policy,
      status: ageDays > maxAge ? "STALE" : "ok",
    });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ max_age_days: maxAge, providers: rows }, null, 2) + "\n");
  } else {
    process.stdout.write(`Pricing data freshness (gate: ${maxAge} days)\n\n`);
    for (const r of rows) {
      const age = r.age_days === null ? "?" : `${r.age_days}d`;
      process.stdout.write(
        `  ${r.status.padEnd(10)} ${r.provider.padEnd(6)} ${(r.last_updated ?? "unknown").padEnd(12)} ` +
          `age=${age.padEnd(6)} refresh=${r.policy}\n`,
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
      `${stale.length} provider(s) exceed ${maxAge} days: ` +
        `${stale.map((r) => `${r.provider} (${r.age_days}d)`).join(", ")}.\n\n` +
        `For a provider refreshed automatically this means the refresh loop has stopped\n` +
        `working - check the Refresh Pricing workflow. For a manually curated one it means\n` +
        `the curation is overdue. Either way the shipped numbers are older than they should\n` +
        `be, and the fix is to refresh the data, not to raise the threshold.\n`,
    );
    process.exit(1);
  }
}

main();
