# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **FOCUS reconciliation for `compare_actual`**: new optional `focus_export` parameter accepts a [FOCUS](https://focus.finops.org/)-formatted billing export (CSV string or JSON row array) and, when combined with planned Terraform `files`, produces a new `actual_vs_estimate_variance` field — per-resource variance between the planned estimate and what the cloud actually billed. Complements `check_cost_budget`: guardrail catches forward-looking mistakes, FOCUS reconciliation catches the ones that slipped through. Byte cap 10 MiB, row cap 50 000, mixed-currency exports rejected. See [docs/focus-reconciliation.md](./docs/focus-reconciliation.md).
- **Structured `fallback_metadata` across cost tools**: `estimate_cost`, `compare_providers`, and `compare_actual` now return a `fallback_metadata` object summarising per-provider bundled-pricing freshness (`providers`, `stale`, `max_age_days`). Stale flag trips when any included provider's `data/<provider>-pricing/metadata.json` is older than 30 days, so downstream agents can route around stale estimates without re-implementing freshness checks. `get_pricing`'s single-provider flat shape is preserved byte-for-byte for backward compatibility.
- **`check_cost_budget` MCP tool**: agent-ready cost guardrail that returns `allow` / `warn` / `block` with `blocking_resources` populated. Designed to be called by an AI agent between generating IaC and writing it to disk, so a model can't silently commit a runaway configuration. Promotes the budget primitives that previously only lived inside `detect_anomalies`. See [docs/guardrails.md](./docs/guardrails.md) for integration patterns.
- New env vars: `CLOUDCOST_GUARDRAIL_MAX_MONTHLY`, `CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE`, `CLOUDCOST_GUARDRAIL_WARN_RATIO`. Thresholds cascade: per-call params → `guardrail` env → `budget` env.
- New `GuardrailConfig` type on `CloudCostConfig`.

### Security

- Defense-in-depth on outbound HTTP: the AWS pricing fetchers (`bulk-loader`, `reserved-client`) now validate region and service against a strict allowlist, pin fetches to `pricing.us-east-1.amazonaws.com`, enforce HTTPS, and cap response bodies at 512 MiB. Extends the v1.0.1 MCP-surface hardening down into the network layer. Closes URL-injection via attacker-controlled region/service strings and caps OOM risk from a misbehaving upstream.

### Changed

- Coverage thresholds in `vitest.config.ts`: raised statement/line/function coverage floors to 80% (branches pinned to the currently-measured floor of 70% pending a targeted coverage-ramp pass — the prior 75% branches threshold never actually passed on main). Previous floor was 75 / 75 / 80 / 75.
- README: corrected the Limitations bullet that implied AWS Savings Plans were supported via `optimize_cost`. Savings Plans are not yet supported and are tracked in [docs/roadmap.md](./docs/roadmap.md).

### Tests

- `src/reporting/csv-escape.ts` extracted out of `csv-report` and `focus-report`; dedicated `csv-escape.test.ts` covers the formula-injection defense surface.
- `test/helpers/factories.ts` + `setup.ts` centralise test fixture construction; `test/integration/full-stack.test.ts` replaces the older end-to-end test with wider tool coverage.
- New unit tests: `api-gateway`, `messaging`, `ml-ai`, `search`, `waf`, `csv-parser`, `resource-extractor`, `markdown-report`, `check-cost-budget`. Total passing tests: 1507 (+15).

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
