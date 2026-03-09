# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
