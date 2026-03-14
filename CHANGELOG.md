# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-03-14

### Added

- `what_if` MCP tool for modeling hypothetical pricing scenarios — change instance types, regions, providers, or commitment levels and see the cost delta without modifying Terraform files
- Multi-currency support across all cost-returning tools (`estimate_cost`, `compare_providers`, `what_if`): USD, EUR, GBP, JPY, CAD, AUD, INR, BRL via `src/currency.ts`
- Spot/preemptible instance pricing model — configure `pricing_model: "spot"` globally via `CLOUDCOST_PRICING_MODEL` or per-scenario in `what_if`
- Cost projections over 3, 6, 12, and 36-month horizons with side-by-side reserved instance comparisons (`src/calculator/projection.ts`)
- Tag-based cost attribution and `group_by` report option for grouping output by team, environment, or any resource tag
- Budget alerts via `CLOUDCOST_BUDGET_MONTHLY`, `CLOUDCOST_BUDGET_PER_RESOURCE`, and `CLOUDCOST_BUDGET_WARN_PCT` — reports surface a warning when estimates exceed the configured threshold
- Terraform module expansion: referenced modules (`source = "..."`) are now resolved during parsing via `src/parsers/module-resolver.ts`; controlled by `CLOUDCOST_RESOLVE_MODULES`
- Resource dependency graph builder (`src/parsers/dependency-graph.ts`) exposed via the `include_dependencies` option on `analyze_terraform`
- OpenTofu support — `.tofu` files are now recognized and parsed alongside standard `.tf` files
- Data transfer cost integration — inter-region and internet egress estimates can be included via `CLOUDCOST_INCLUDE_DATA_TRANSFER`
- FOCUS-compliant export format (`src/reporting/focus-report.ts`) — pass `format: "focus"` to `compare_providers`
- Live GCP Cloud Billing Catalog API client (`src/pricing/gcp/cloud-billing-client.ts`) with automatic fallback to bundled data when the API is unreachable
- Support for three new resource categories: Container Registries (`aws_ecr_repository`, `azurerm_container_registry`, `google_artifact_registry_repository`), Secrets Management (`aws_secretsmanager_secret`, `azurerm_key_vault`, `google_secret_manager_secret`), and DNS (`aws_route53_zone`, `azurerm_dns_zone`, `google_dns_managed_zone`)
- GitHub Actions composite action (`.github/actions/cost-estimate/`) for posting cost estimate comments to pull requests on Terraform changes
- `currency` input added to the GitHub Actions composite action

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
- Real-time pricing from public APIs with no API keys or cloud credentials required — AWS via Bulk Pricing CSV/JSON, Azure via the Retail Prices REST API
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
