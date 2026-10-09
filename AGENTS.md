# CloudCostMCP

Help users understand multi-cloud infrastructure costs with explainable estimates,
visible assumptions and stable MCP/CLI interfaces. Estimates are not billing
guarantees. Work from the selected revision; in sparse checkouts use
`git ls-tree -r --name-only HEAD` and `git show HEAD:<path>` before declaring code
missing. Prefer current implementation, package scripts and workflows over stale
examples in contributor documentation.

## Find the relevant source

| Task | Start here |
| --- | --- |
| IaC parsing, variables, modules | `src/parsers/index.ts`, `format-detector.ts`, the relevant parser/extractor, `test/unit/parsers/`, `test/fixtures/` |
| Provider prices and freshness | `src/pricing/pricing-engine.ts`, provider adapters, `src/data/loader.ts`, `src/data/freshness.ts`, `data/*-pricing/metadata.json`, `test/unit/pricing/`, `test/unit/data/` |
| Cost arithmetic and comparisons | `src/calculator/`, `src/mapping/`, `src/types/pricing.ts`, `src/currency.ts`, corresponding unit tests |
| MCP, CLI and reports | `src/tools/`, `src/schemas/`, `src/server.ts`, `src/cli.ts`, `src/reporting/`, `VERSIONING.md` |
| Pricing maintenance or release | `scripts/refresh-pricing.ts`, `scripts/check-freshness.ts`, `docs/PRICING_HEALTH.md`, `.github/workflows/` |

## Preserve meaning and contracts

- Preserve `parse_warnings` and resource identity through parsing. Check variable,
  count/for_each and module cases when changing extraction. Keep module path
  containment and bounded inputs; consult `test/unit/security/` for those changes.
  Do not describe unresolved or skipped inputs as a complete inventory.
- AWS/Azure have live and fallback paths; GCP deliberately uses bundled pricing.
  Preserve source, confidence, notes and freshness disclosures. Keep data vintage
  (`last_updated`) distinct from refresh verification (`last_verified`); use the
  shared freshness policy rather than inventing a threshold or relabeling old
  data as current. Unknown metadata is reported stale.
- Missing pricing is not proof of zero cost. Preserve low-confidence zero-cost
  warnings and non-live pricing disclosures. The cost engine currently logs and
  drops rejected calculations: do not claim complete coverage or an existing
  fail-closed completeness check. For affected behavior, test missing/stale data
  and partial failures as well as successful lookups.
- Trace quantity × unit price through the relevant calculator. Respect hourly
  versus monthly/storage units and configured monthly hours (compute defaults
  to 730); a per-vCPU price is not a whole-instance price. Preserve the estimate
  factory's rounding and yearly calculation. Synthetic egress remains included
  in totals when enabled and disclosed through warnings/`estimated_egress_monthly`.
- Calculators price in USD. Currency conversion uses static rates in
  `src/currency.ts`; retain original USD totals and exchange-rate vintage where
  emitted. Do not describe these rates as live FX.
- Follow `VERSIONING.md` for the stable tool names, schemas, output types,
  binaries and documented CLI flags. Preserve JSON text result envelopes and
  `isError` handling in `src/tools/index.ts`, CLI success/failure behavior, and
  stderr logging so MCP stdout remains JSON-RPC. Keep tools read-only with
  respect to user infrastructure and source files; local pricing caches exist.

## Verify the affected behavior

Use the Node requirement in `package.json` (currently `>=20.20.2`). With existing
dependencies, run the relevant subset, for example:

```sh
npm test -- test/unit/parsers
npm test -- test/unit/pricing test/unit/calculator test/unit/data
npm test -- test/unit/tools test/unit/cli test/unit/reporting test/unit/security
npm run check
```

Choose checks by the change; documentation-only work needs source/path and diff
checks, not an installation. For code delivery, run `npm run build` before the
full `npm test` or `npm run test:coverage`: CLI/stdio tests exercise `dist`.
CI runs lint, formatting, coverage and build across its Node matrix.
`test/helpers/setup.ts` disables fetch unless `RUN_INTEGRATION=1`; keep ordinary
tests deterministic. Live smoke/drift tests and calendar freshness belong to
health/release verification and are not evidence supplied by offline unit tests.
Report unrun checks explicitly. `npm ci` invokes the build through `prepare`.

## Delivery

Keep changes focused. PRs use `.github/PULL_REQUEST_TEMPLATE.md` and explain the
problem, resulting behavior, actual checks and material limits; pricing changes
also explain how the numbers were verified. Docs lead with the useful outcome.
Use concise `type: concrete change` commits and record breaking changes under
the versioning contract. Never mark an unrun template check as passed.

A main push runs CI and uploads a build artifact; publishing a GitHub release
triggers npm publication with provenance and an SBOM release attachment, gated
by tests, production audit and pricing freshness. Pricing refresh/recovery and
health workflows can write branches, PRs or issues and dispatch/retry runs.
Treat those actions and package publication as separate from local verification;
perform them only within the user's authorized delivery scope.
