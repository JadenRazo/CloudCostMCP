# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **GCP pricing had not refreshed since 2026-04-15.** `scripts/refresh-pricing.ts`
  read `gstatic.com/cloud-site-ux/pricing/data/gcp-compute.json`, an undocumented
  Google asset that has returned 404 since before the first scheduled run on
  2026-04-20. All 16 scheduled refreshes failed; the GCP fetcher never once
  succeeded. Bundled GCP data is now rebuilt weekly from the
  [gcosts](https://github.com/Cyclenerd/google-cloud-pricing-cost-calculator)
  snapshot of the Cloud Billing Catalog (Apache-2.0), which also extends
  coverage from 17 regions to 37.

- **GCP compute prices were reconstructed, and the reconstruction was wrong for
  newer families.** The old refresh derived every instance price as
  `vcpus * coreRate + memGb * memRate`. That collapsed c3 and c4 to identical
  prices in all 102 region/shape pairs, which they are not. The new source ships
  assembled per-instance rates, so the derivation is gone. 944 of 1,197 existing
  values are unchanged; the 253 that moved are corrections in the c2d, c3, c4 and
  n4 families. `c2d-standard-4` and `c2d-standard-8` shipped in the data file but
  were absent from the refresh allow-list, so nothing had ever refreshed them.

- **Cloud Storage regional prices were multiplier-derived, not real.**
  `asia-southeast1` was recorded as pricier than `us-central1`; both are in the
  same $0.020 Standard tier. Two tests asserted the incorrect ordering and now
  assert against a region that genuinely differs.

- **The live GCP path could not work, and would have been harmful if it had.**
  `CloudBillingClient` queried `cloudbilling.googleapis.com`, which answers
  unregistered callers with `403 PERMISSION_DENIED`, so every uncached GCP lookup
  paid a guaranteed-failing round trip before serving bundled data. Worse, its
  compute path returned the per-vCPU "Instance Core" SKU as the whole-instance
  price: an `e2-standard-2` would have priced at roughly $0.021/hr against a true
  $0.067/hr, and live was preferred over bundled. The 403 was the only thing
  preventing a silent ~3x under-estimate on every machine type. The client is
  removed and `GcpProvider` is bundled-only.

- **The GCP smoke test was built to skip on the only failure it could see.**
  `fetchComputeSkus` returns `null` on any error, and the test read `null` as an
  "upstream catalog miss" and called `ctx.skip()`. A hard 403 was reported as a
  green skip, which is why the daily health check scored "live provider APIs: ok"
  throughout the outage. It now probes the source the refresh actually depends
  on, imported rather than retyped, and a non-2xx fails.

- **The health check asked whether the refresh ran, not whether it worked.**
  `health.yml` requested the last run's `conclusion` and used only `createdAt`,
  so sixteen consecutive failures scored a healthy `LOOP=0`. It now evaluates the
  conclusion, and an unparseable timestamp reports as unknown instead of being
  mislabelled as "has not run recently".

- **AWS and Azure could have rotted the same way, silently.** Their fetch helpers
  return empty maps on failure, every SKU falls through to "no live data", and
  the metadata was stamped with today's date regardless - no failed run, no issue.
  Both now refuse to stamp when live coverage falls below 80% of known SKUs. GCP
  was only ever loud because its fetcher happened to return before the stamp.

- **The weekly refresh PR deadlocked every Monday.** `create-pull-request` was
  passed no `token:`, so it force-pushed as `github-actions[bot]`; under this
  repo's `first_time_contributors` approval policy those runs park at
  `action_required` with zero jobs allocated. PR #38 sat that way for six days.
  The workflow now mints a scoped GitHub App token when one is configured, and
  falls back to the previous behaviour when it is not.

### Changed

- **`metadata.json` carries two dates and a policy.** `last_updated` is the
  vintage of the numbers, `last_verified` is when the refresh loop last completed,
  and `refresh_policy` is `automated` or `curated`. One date was doing the work of
  two: for GCP it was real vintage, for AWS/Azure an unconditional heartbeat, and
  one 21-day threshold was applied to both. `curated_datasets` now names the
  tables no automation refreshes (GCP Cloud SQL, AWS EBS, Azure disk/database),
  which the automated stamp used to silently re-certify as fresh.
  `pricing_metadata` reports the older of the two dates, never the flattering one.

- **`refresh_policy` is finally written.** `check-freshness.ts` has read the field
  since it was created but nothing set it, so every row printed
  `refresh=unspecified` and the gate could not tell a dead loop from overdue
  curation.

- **CI.** `fail-fast: false` on the test matrix (a formatting nit in one file
  cancelled the Node 20 leg and destroyed its signal); Node 24.15.0 added to the
  matrix, since that is the version that actually ships; `npm run format:check`
  instead of a direct prettier call, so CI and the documented local gate cannot
  drift; `build-artifact` restricted to `main`, where it is not duplicating a
  build the matrix already ran three times.

- **`cost-estimate-example.yml` moved to `examples/`.** Its first line said it was
  a file to copy; GitHub registered and ran it on every pull request anyway. The
  composite action's self-install pin moved from 1.0.1 to 1.2.1.

- **README.** Corrected the claims that GCP pricing is fetched live from the Cloud
  Billing Catalog API using "unauthenticated public endpoints", and that bundled
  data is refreshed weekly - true for AWS and Azure, false for GCP for 128 days.


## [1.2.1] - 2026-08-07

### Fixed

- **The `cloudcost` CLI could not start.** `dist/cli.js` shipped with two
  `#!/usr/bin/env node` lines — one from `src/cli.ts` and one from the
  `banner.js` that `tsup.config.ts` injects into every bundle. Node strips only
  a line-1 shebang, so the second parsed as code and the binary died with
  `SyntaxError: Invalid or unexpected token`. The shebang is now declared in
  exactly one place (the tsup banner). This affected every published release up
  to and including 1.2.0, so 1.2.0's `--currency` flag was unreachable in
  practice. The MCP server entrypoint (`cloudcost-mcp`) was never affected —
  `src/index.ts` carried no shebang of its own.

### Tests

- `test/unit/cli/shebang.test.ts` guards the artifact users actually run: no
  source entrypoint may declare a shebang, each built bin must contain exactly
  one on line 1, and `dist/cli.js` must start under Node. The existing CLI
  suites all execute `src/cli.ts` through the TypeScript loader, which is why a
  build-output defect went unnoticed across six releases.

## [1.2.0] - 2026-08-07

> Released as 1.2.0, not 1.1.0. The `v1.1.0` tag was already taken by an earlier
> 2026-04-16 release that was superseded by the `v1.0.1` hotfix and never
> published to npm; npm therefore goes `1.0.1` → `1.2.0`.

### Added

- **`check_cost_budget` MCP tool**: agent-ready cost guardrail that returns `allow` / `warn` / `block` with `blocking_resources` populated. Designed to be called by an AI agent between generating IaC and writing it to disk, so a model can't silently commit a runaway configuration. Promotes the budget primitives that previously only lived inside `detect_anomalies`. See [docs/guardrails.md](./docs/guardrails.md) for integration patterns.
- New env vars: `CLOUDCOST_GUARDRAIL_MAX_MONTHLY`, `CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE`, `CLOUDCOST_GUARDRAIL_WARN_RATIO`. Thresholds cascade: per-call params → `guardrail` env → `budget` env.
- New `GuardrailConfig` type on `CloudCostConfig`.

### Security

- Defense-in-depth on outbound HTTP: the AWS pricing fetchers (`bulk-loader`, `reserved-client`) now validate region and service against a strict allowlist, pin fetches to `pricing.us-east-1.amazonaws.com`, enforce HTTPS, and cap response bodies at 512 MiB. Extends the v1.0.1 MCP-surface hardening down into the network layer. Closes URL-injection via attacker-controlled region/service strings and caps OOM risk from a misbehaving upstream.

### Changed

- MCP tools migrated from the deprecated `server.tool()` to `server.registerTool()`. Every tool now advertises `annotations.readOnlyHint: true`, and handler failures return a JSON `{error}` text payload with `isError: true` instead of a protocol-level failure. `check_cost_budget`'s structured error results (`provider_unresolved`, `non_finite_total`) also set `isError`. Result payloads remain JSON text in `content[0].text` — no client-facing format change.
- Graceful shutdown: SIGINT/SIGTERM now close the MCP server connection and the SQLite pricing cache before exit; `unhandledRejection` logs, closes, and exits instead of hard-exiting.
- Per-resource `monthly_cost` / `yearly_cost` on every `CostEstimate` are now consistently rounded to cents via the new shared estimate factory (previously only data-transfer estimates were rounded; totals were already rounded).
- Data-transfer (egress) estimates now read regional multipliers from the shared `data/region-price-multipliers.json` instead of drifted per-provider in-file tables; estimates in non-baseline regions shift slightly.
- Azure and GCP pricing normalizers validate/canonicalize upstream effective dates the same way AWS does (invalid dates fall back to "now"; valid ones normalize to ISO `.000Z` form).
- Coverage thresholds in `vitest.config.ts` set to 75 / 71 / 80 / 75 (statements / branches / functions / lines) and now enforced in CI: the test job runs `npm run test:coverage`, so a regression below the floor fails the build. 71 is the measured branch-coverage floor at gate-enable time; the other thresholds were already met.
- Lint upgraded to typescript-eslint `recommendedTypeChecked` for `src/` with `@typescript-eslint/no-explicit-any` promoted to error; the publish workflow now runs `npm run lint` before publishing and attaches a CycloneDX SBOM (`sbom.cdx.json`) to each GitHub release.
- README: corrected the Limitations bullet that implied AWS Savings Plans were supported via `optimize_cost`. Savings Plans are not yet supported and are tracked in [docs/roadmap.md](./docs/roadmap.md).

### Tests

- `src/reporting/csv-escape.ts` extracted out of `csv-report` and `focus-report`; dedicated `csv-escape.test.ts` covers the formula-injection defense surface.
- `test/helpers/factories.ts` + `setup.ts` centralise test fixture construction; `test/integration/full-stack.test.ts` replaces the older end-to-end test with wider tool coverage.
- New unit tests: `api-gateway`, `messaging`, `ml-ai`, `search`, `waf`, `csv-parser`, `resource-extractor`, `markdown-report`, `check-cost-budget`.
- New `register-tools` suite locks the MCP surface: all 12 tools register, names match VERSIONING.md's locked table, every tool carries `readOnlyHint`, and the error envelope (`isError` + JSON `{error}`) is exercised end-to-end over an in-memory transport.

## [1.0.1] - 2026-04-18

### Security

Hardened the MCP tool surface against the attack classes catalogued in the OWASP MCP Top 10 (2025) and recent SDK advisories. No breaking API changes.

- **Path traversal in module resolution (HIGH)**: A `module { source = "../../../etc" }` declaration in user-supplied HCL previously resolved without any containment check, turning any file-accepting tool into an arbitrary `*.tf` read primitive. All resolved paths are now confined to `process.cwd()` by default (configurable), symlinks are rejected, and `modules.json` entries are re-validated against the boundary. Added `src/parsers/path-safety.ts`.
- **MCP SDK floor (MED)**: Bumped `@modelcontextprotocol/sdk` minimum from `^1.12.1` to `^1.25.2` so fresh installs cannot resolve a version affected by CVE-2025-66414 (DNS rebinding, `< 1.24.0`) or CVE-2026-0621 (UriTemplate ReDoS, `< 1.25.2`).
- **Prototype pollution in `plan_json` / `state_json` (MED)**: Raw `JSON.parse` on user input followed by deep-merge was vulnerable to `__proto__` / `constructor` / `prototype` payloads. Added `safeJsonParse` with a reviver that strips these keys, applied to the Terraform plan and state parsers and to the HCL-JSON merge in `module-resolver`.
- **Output-channel prompt injection ("Poison Everywhere", MED)**: User-supplied filenames, module names, and error strings were echoed verbatim into error responses and warnings. Added `sanitizeForMessage` which strips ASCII control characters, zero-width / bidi-override characters, and caps length; applied at every point where tool results flow back to the MCP client.
- **Input-size DoS (LOW-MED)**: Tool inputs had no size limits. Added Zod `.max()` on every accepting schema — 5 MiB per file, 20 MiB per plan/state payload, 1 KiB per path, max 2000 files per request.

### Tests

- Added `test/unit/security/mcp-hardening.test.ts` with 19 regression tests covering sanitisation, prototype-pollution guards, path-boundary enforcement, symlink rejection, and every new Zod size limit.

## [1.0.0] - 2026-04-15

First stable release. No breaking API changes from 0.5 — this version ratifies the existing surface as SemVer-locked. See [`VERSIONING.md`](./VERSIONING.md#migration-notes) for details.

### Added
- **`VERSIONING.md`**: Formal stability contract defining the SemVer-locked public surface (12 MCP tools, CLI binaries, package entry points), the change-classification policy, and the 0.x → 1.0 migration notes. (At release this lived in two files, `STABILITY.md` and `MIGRATION.md`; they were later consolidated.)
- **Smoke integration tests**: Live-API smoke coverage for AWS Bulk Pricing, Azure Retail Prices, and GCP Cloud Billing Catalog, gated behind `RUN_INTEGRATION=1`. New `integration-smoke` CI job runs on manual dispatch and weekly schedule (Mondays 12:00 UTC).
- **Publish workflow gates**: `npm audit --audit-level=high` and `npm test` now run before `npm publish`, preventing broken or vulnerable releases.

### Security
- Resolved transitive advisories via npm `overrides`:
  - `hono` → `^4.12.12` (GHSA-26pp-8wgv-hjvm, GHSA-r5rp-j6wh-rvv4, GHSA-xf4j-xp2r-rqqx, GHSA-wmmm-f939-6g9c, GHSA-xpcf-pg52-r92g)
  - `@hono/node-server` → `^1.19.13` (GHSA-92pp-h63x-v22m)
  - `path-to-regexp` → `^8.4.0` (GHSA-j3q9-mxjg-w52f, GHSA-27v5-c462-wpq7)
  - `vite` → `^7.3.2` (GHSA-4w7w-66w2-5vf9, GHSA-v2wj-q39q-566r)
- `npm audit --audit-level=high` now reports zero vulnerabilities.

### Packaging
- `VERSIONING.md` and `CHANGELOG.md` are now included in the published npm tarball. (Originally shipped as `STABILITY.md` + `MIGRATION.md`, now merged.)

## [0.4.0] - 2026-03-28

### Added
- **Multi-IaC support**: CloudFormation (JSON/YAML), Pulumi (stack export), and Bicep/ARM template parsing via unified `IaCParser` interface with auto-format detection
- **`analyze_plan` tool**: Parse `terraform plan -json` output for precise before/after cost-of-change analysis
- **`compare_actual` tool**: Parse `.tfstate` files to compare actual infrastructure costs against estimates
- **`price_trends` tool**: Historical pricing with SQLite-backed price snapshots, change tracking, and trend queries
- **`detect_anomalies` tool**: Cost anomaly detection with budget checks, price change alerts, concentration risk, and right-sizing hints
- **API Gateway pricing**: AWS REST/HTTP/WebSocket, Azure API Management, GCP API Gateway
- **WAF pricing**: AWS WAFv2, Azure WAF Policy
- **OpenSearch pricing**: AWS OpenSearch Domain with per-instance-type tables
- **Messaging pricing**: AWS SNS/MQ Broker, Azure Service Bus/Event Hubs, GCP Pub/Sub
- **ML/AI pricing**: AWS SageMaker endpoints (40+ instance types), GCP Vertex AI (confidence: low)
- **Expanded Redis**: Full Azure Redis Cache and GCP Redis Instance support
- **ESLint + Prettier**: Flat config ESLint with TypeScript rules, Prettier formatting enforced
- **Coverage thresholds**: 70%+ statement/branch/function/line coverage enforced via vitest
- **Performance benchmarks**: Parsing, pricing cache, and calculator benchmarks via `vitest bench`
- **CI hardening**: Security audit job, Prettier format check, concurrency groups, job timeouts
- **SECURITY.md**: Vulnerability reporting policy and security design documentation
- **`docs/architecture.md`**: Layered architecture documentation with extension guides (originally at repo root, moved to `docs/` in a later cleanup).

### Changed
- Refactored `bulk-loader.ts` (929 -> 708 lines) into focused modules: csv-parser, fallback-data
- Refactored `resource-extractor.ts` (778 -> 299 lines) into per-provider extractors
- Refactored `retail-client.ts` (614 -> 499 lines) with extracted fallback-data
- Replaced ~40 `any` types in pricing modules with proper TypeScript interfaces
- Updated CI pipeline with security audit job and format checking

### Fixed
- picomatch HIGH severity vulnerability (ReDoS + method injection)
- Unused imports and variables across codebase (ESLint cleanup)

### Security
- Resolved picomatch 4.0.0-4.0.3 vulnerability via npm audit fix
- Added `npm audit --audit-level=high` to CI pipeline

## [0.3.0] - 2026-03-14

### Added

- `what_if` MCP tool for hypothetical pricing scenarios (change instance types, regions, commitment levels; see cost delta without modifying Terraform)
- Multi-currency support on `estimate_cost`, `compare_providers`, `what_if`: USD, EUR, GBP, JPY, CAD, AUD, INR, BRL
- Spot/preemptible instance pricing model via `CLOUDCOST_PRICING_MODEL` or per-scenario in `what_if`
- Cost projections over 3/6/12/36-month horizons with reserved instance comparisons (`src/calculator/projection.ts`)
- Tag-based cost attribution and `group_by` report option for grouping by team, environment, or any resource tag
- Budget alerts via `CLOUDCOST_BUDGET_MONTHLY`, `CLOUDCOST_BUDGET_PER_RESOURCE`, `CLOUDCOST_BUDGET_WARN_PCT`
- Terraform module expansion: referenced modules (`source = "..."`) resolved during parsing; controlled by `CLOUDCOST_RESOLVE_MODULES`
- Resource dependency graph via `include_dependencies` option on `analyze_terraform`
- OpenTofu `.tofu` file support alongside `.tf` files
- Data transfer cost integration (inter-region and internet egress) via `CLOUDCOST_INCLUDE_DATA_TRANSFER`
- FOCUS-compliant export format. Pass `format: "focus"` to `compare_providers`
- Live GCP Cloud Billing Catalog API client with automatic fallback to bundled data
- Container Registries, Secrets Management, and DNS resource types across all three providers
- GitHub Actions composite action for posting cost estimates as PR comments
- `currency` input on the GitHub Actions composite action

### Changed

- GCP pricing now attempts the live Cloud Billing Catalog API first and falls back to bundled data; `pricing_source` reflects `"live"` or `"bundled"` accordingly
- `compare_providers` `format` parameter now accepts `focus` in addition to `markdown`, `json`, and `csv`
- `analyze_terraform` `include_dependencies` option now returns a full dependency adjacency list alongside the resource inventory

### Fixed

- Variable references that were not resolved when a `terraform.tfvars` file contained complex expressions are now handled with a safe fallback rather than surfacing a parse error
- Concurrent pricing fetches for the same AWS region no longer trigger duplicate CSV downloads; a single in-flight request is now shared across callers

## [0.1.0] - 2026-03-09

### Added

- Six MCP tools exposed over stdio: `analyze_terraform`, `estimate_cost`, `compare_providers`, `get_equivalents`, `get_pricing`, and `optimize_cost`
- Multi-cloud cost analysis across AWS, Azure, and GCP from a single Terraform codebase
- HCL/Terraform parsing via `@cdktf/hcl2json` with full variable resolution, including `terraform.tfvars` support
- Real-time pricing from public APIs with no API keys or cloud credentials required (AWS Bulk Pricing CSV/JSON, Azure Retail Prices REST API)
- Streaming ingestion of the AWS EC2 bulk pricing CSV (~267 MB) line-by-line to avoid loading the full file into memory; all on-demand prices for a region are extracted in one pass
- Bundled GCP pricing data covering Compute Engine, Cloud SQL, Cloud Storage, Persistent Disk, and infrastructure services across all major regions
- Graceful fallback to built-in pricing tables with size-interpolation when live sources are unavailable; every price includes a `pricing_source` field (`live`, `fallback`, or `bundled`) for transparency
- SQLite-backed pricing cache (`better-sqlite3`) at `~/.cloudcost/cache.db` with a configurable TTL (default 24 hours), shared across all tools per server lifetime
- Cross-provider resource and instance type mapping covering 70+ AWS instance types (including Graviton/ARM families), 40+ Azure VM sizes, and 20+ GCP machine types with full bidirectional lookup
- Support for five resource categories: compute, database, storage, networking, and Kubernetes, across all three providers
- Reserved instance and savings plan pricing analysis within the `optimize_cost` tool alongside right-sizing and cross-provider switching recommendations
- Cost reports in Markdown, JSON, and CSV formats with per-resource monthly and yearly breakdowns and confidence scores
- Three-layer configuration system: built-in defaults → `~/.cloudcost/config.json` → `CLOUDCOST_*` environment variables
- ESM-only package targeting Node.js 20+, built with `tsup` and tested with `vitest`
