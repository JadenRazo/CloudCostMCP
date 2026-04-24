# Architecture

This document describes the internal structure of CloudCost MCP, the data flow from IaC input to cost output, the key design decisions, and the extension points for adding providers, resource types, and output formats.

## High-Level Data Flow

```
IaC Files
    |
    v
[Parsers]          src/parsers/
    |  HCL → JSON, variable resolution, module expansion, resource extraction
    v
[Resource Inventory]   ParsedResource[]
    |
    v
[Mapping]          src/mapping/
    |  Cross-provider resource types, instance sizes, storage types, regions
    v
[Calculator]       src/calculator/
    |  Per-resource-type cost calculations, data transfer, projections
    |
    +---> [Pricing Engine]   src/pricing/
              |  Routes requests to provider adapters; manages cache
              |
              +--- AWS:   Bulk CSV streaming + JSON + fallback tables
              +--- Azure: Retail Prices REST API + fallback tables
              +--- GCP:   Cloud Billing Catalog API + bundled JSON files
    v
[Cost Breakdown]   CostBreakdown (per-resource estimates + by_service totals)
    |
    v
[Reporting]        src/reporting/
    |  Markdown, JSON, CSV, FOCUS formatters
    v
[MCP Tools]        src/tools/
    |  7 tool handlers with Zod schema validation, stdio transport
    v
MCP Client (Claude Desktop, Claude Code, any MCP-compatible agent)
```

## Layer Descriptions

### Parsers (`src/parsers/`)

The parser layer converts raw HCL into a normalized `ParsedResource[]` inventory.

| File                    | Responsibility                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hcl-parser.ts`         | Converts HCL text to a JSON object via `@cdktf/hcl2json` (WASM). Handles both `.tf` and `.tofu` files — they share identical syntax.                                              |
| `variable-resolver.ts`  | Resolves `var.*` references against declared variable defaults and an optional `tfvars` input. Complex expressions that cannot be resolved fall back safely rather than throwing. |
| `provider-detector.ts`  | Infers the cloud provider (aws, azure, gcp) from `provider` blocks and resource type prefixes.                                                                                    |
| `resource-extractor.ts` | Walks the parsed JSON and produces `ParsedResource` objects with cost-relevant attributes (instance type, storage size, engine, count, region, tags).                             |
| `module-resolver.ts`    | Expands `source = "..."` module references. Controlled by `CLOUDCOST_RESOLVE_MODULES` (default: `true`).                                                                          |
| `dependency-graph.ts`   | Builds a resource dependency adjacency list. Returned alongside the inventory when `include_dependencies: true` is passed to `analyze_terraform`.                                 |

The parser outputs `ParsedResource` objects defined in `src/types/resources.ts`. Every attribute that a downstream calculator needs must be extracted here.

### Mapping (`src/mapping/`)

The mapping layer translates resource identifiers and instance sizes across providers. It is pure data — no network calls, no async.

| File                 | Responsibility                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource-mapper.ts` | Bidirectional lookup of equivalent Terraform resource types (e.g., `aws_instance` → `azurerm_linux_virtual_machine`). Data source: `data/instance-map.json`.     |
| `instance-mapper.ts` | Maps instance type strings across providers (e.g., `t3.large` → `Standard_B2s` → `n2-standard-2`). Covers 70+ AWS types, 40+ Azure sizes, 20+ GCP machine types. |
| `storage-mapper.ts`  | Maps storage types across providers (e.g., `gp3` → `Premium_LRS` → `pd-ssd`). Data source: `data/storage-map.json`.                                              |
| `region-mapper.ts`   | Normalizes region name formats across providers (e.g., `us-east-1` → `eastus` → `us-east1`).                                                                     |

All mapping data is loaded once at startup via `src/data/loader.ts` and held in memory.

### Pricing Engine (`src/pricing/`)

The pricing engine is the only layer that makes outbound network requests. It follows a strict fallback chain for each provider.

**`PricingEngine` (`pricing-engine.ts`)** is the unified entry point. It holds one `PricingProvider` instance per cloud provider and routes requests based on the `service` string. It is intentionally thin — all pricing logic lives in the provider adapters.

**`PricingProvider` interface** defines the contract every provider adapter must satisfy:

```typescript
interface PricingProvider {
  getComputePrice(instanceType, region, os?): Promise<NormalizedPrice | null>;
  getDatabasePrice(instanceType, region, engine?): Promise<NormalizedPrice | null>;
  getStoragePrice(storageType, region, sizeGb?): Promise<NormalizedPrice | null>;
  getLoadBalancerPrice(type, region): Promise<NormalizedPrice | null>;
  getNatGatewayPrice(region): Promise<NormalizedPrice | null>;
  getKubernetesPrice(region, mode?): Promise<NormalizedPrice | null>;
}
```

#### AWS (`src/pricing/aws/`)

1. **Bulk CSV streaming** (primary for EC2). The AWS Bulk Pricing CSV for the target region (~267 MB) is streamed line-by-line using the Web Streams API. All on-demand prices for the region are extracted in one pass and written to the SQLite cache. Concurrent requests for the same region share a single in-flight download — a second caller waits for the first rather than triggering a duplicate fetch.

2. **Bulk JSON API** (primary for RDS, S3, ELB, VPC). Regional JSON files from `pricing.us-east-1.amazonaws.com` are small enough to parse directly.

3. **Fallback tables + interpolation**. If live fetching fails, built-in tables cover 85+ EC2 and 29 RDS instance types. Unlisted sizes within known families are estimated using `interpolateByStepOrder` (`src/pricing/interpolation.ts`), which follows AWS's power-of-two size progression (nano → micro → small → ... → 48xlarge).

#### Azure (`src/pricing/azure/`)

1. **Azure Retail Prices API** (primary). OData-filtered requests to `prices.azure.com/api/retail/prices` match on `armSkuName` for exact SKU pricing. The full paginated result set is consumed. No authentication required.

2. **Fallback tables + vCPU interpolation**. If the API is unreachable, built-in tables cover 40+ VM sizes and 14 database tiers. `interpolateByVcpuRatio` estimates unlisted sizes by linear scaling from the nearest known entry in the same family.

#### GCP (`src/pricing/gcp/`)

1. **Cloud Billing Catalog API** (primary). Queries `cloudbilling.googleapis.com` using public unauthenticated endpoints. Results are cached for 24 hours.

2. **Bundled pricing data** (fallback). `data/gcp-pricing/` ships with the package and covers Compute Engine machine types, Cloud SQL tiers, Cloud Storage classes, and Persistent Disk types across all major regions. Persistent disk prices (`pd-*`) always use bundled data because they are not catalogued individually in the Cloud Storage service.

3. **Fixed rates**. Load balancer, Cloud NAT, and GKE control plane pricing use fixed public rates from bundled data; these change infrequently.

**`PricingCache` (`src/pricing/cache.ts`)** is a `better-sqlite3`-backed store shared across all tools per server lifetime. It caches `NormalizedPrice` objects keyed by `(provider, service, resourceType, region)` with a configurable TTL (default: 86400 seconds).

Every `NormalizedPrice` object carries a `pricing_source` field: `"live"`, `"fallback"`, or `"bundled"`. This surfaces in cost estimates and reports.

### Calculator (`src/calculator/`)

The calculator layer maps each `ParsedResource` to a `CostEstimate` containing `monthly_cost`, `yearly_cost`, `confidence`, and a line-item `breakdown`.

**`CostEngine` (`cost-engine.ts`)** is the top-level orchestrator. It:

1. Classifies each resource type using `Set` membership checks.
2. Dispatches to the appropriate sub-calculator.
3. Fans out all calculations concurrently via `Promise.allSettled()` — a single pricing failure does not abort the entire breakdown.
4. Aggregates results into a `CostBreakdown` with `by_service` totals and budget warnings.

Sub-calculators by category:

| File                    | Resource categories handled                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `compute.ts`            | EC2 instances, Azure VMs, GCP compute instances, EKS/AKS/GKE node groups              |
| `database.ts`           | RDS, Aurora, Azure Database flexible servers, Cloud SQL                               |
| `storage.ts`            | EBS volumes, managed disks, S3, Azure Storage accounts, GCS buckets, Persistent Disks |
| `network.ts`            | Load balancers, NAT gateways                                                          |
| `kubernetes.ts`         | EKS, AKS, GKE control planes                                                          |
| `serverless.ts`         | Lambda, DynamoDB, SQS, Azure Functions, Cloud Run, Cloud Functions                    |
| `cache.ts`              | ElastiCache, Azure Cache for Redis, Memorystore, CloudFront                           |
| `paas.ts`               | Azure App Service Plans, Cosmos DB, BigQuery                                          |
| `data-transfer.ts`      | Inter-region and internet egress estimates (synthetic resources)                      |
| `container-registry.ts` | ECR, Azure Container Registry, Artifact Registry                                      |
| `secrets.ts`            | Secrets Manager, Key Vault, Secret Manager                                            |
| `dns.ts`                | Route 53, Azure DNS, Cloud DNS                                                        |
| `projection.ts`         | 3/6/12/36-month cost projections with reserved instance comparisons                   |
| `optimizer.ts`          | Right-sizing, reserved pricing, and cross-provider switching recommendations          |
| `reserved.ts`           | Reserved instance pricing calculations                                                |

When `CLOUDCOST_INCLUDE_DATA_TRANSFER=true`, `CostEngine` appends a synthetic data transfer line item per unique provider+region combination. These synthetic resources are created internally and never appear in Terraform configurations.

### Tools (`src/tools/`)

The tools layer is the MCP interface. Each tool is a single file exporting a Zod schema and an async handler.

| Tool                | Handler file           | Description                                                      |
| ------------------- | ---------------------- | ---------------------------------------------------------------- |
| `analyze_terraform` | `analyze-terraform.ts` | Parse HCL, resolve variables, return resource inventory          |
| `estimate_cost`     | `estimate-cost.ts`     | Cost breakdown for a single provider                             |
| `compare_providers` | `compare-providers.ts` | Full pipeline: parse → map → price → report across all providers |
| `get_equivalents`   | `get-equivalents.ts`   | Cross-provider resource and instance type lookup                 |
| `get_pricing`       | `get-pricing.ts`       | Direct normalized price lookup                                   |
| `optimize_cost`     | `optimize-cost.ts`     | Right-sizing and reserved pricing recommendations                |
| `what_if`           | `what-if.ts`           | Hypothetical scenario modeling without modifying Terraform       |

All tools are registered in `src/tools/index.ts` via `server.tool(name, schema.shape, handler)`. A single `PricingCache` and `PricingEngine` are shared across all tools so the SQLite database is opened exactly once per server lifetime.

Handlers always return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.

### Reporting (`src/reporting/`)

Formatters consume a `ComparisonReport` or `CostBreakdown` and return a string in the requested format.

| File                 | Format   | Notes                                                                                   |
| -------------------- | -------- | --------------------------------------------------------------------------------------- |
| `markdown-report.ts` | Markdown | Default. Table per provider, per-resource rows, optimization callouts.                  |
| `json-report.ts`     | JSON     | Full structured output including `by_resource` and `by_service` maps.                   |
| `csv-report.ts`      | CSV      | Flat rows, one per resource per provider. Suitable for spreadsheet import.              |
| `focus-report.ts`    | FOCUS    | [FinOps Open Cost and Usage Specification](https://focus.finops.org/) compliant export. |

## Key Design Decisions

### Zero API Keys

All three providers expose public pricing endpoints that require no authentication. The server never reads environment variables for `AWS_ACCESS_KEY_ID`, `AZURE_CLIENT_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS`, or equivalent. This is a hard design constraint: it allows the server to run in any environment without IAM setup and eliminates the risk of credential exposure.

### Graceful Fallback Chain

Every pricing lookup goes through a defined fallback chain. If the live source is unavailable (network timeout, 5xx, etc.), the server falls back to built-in tables. If the exact instance type is not in the tables, size interpolation produces an estimate. This means the server always returns a number — callers can evaluate confidence using the `pricing_source` and `confidence` fields on each estimate rather than handling exceptions.

### Streaming CSV for AWS EC2 Pricing

The AWS EC2 bulk pricing CSV exceeds 267 MB. Loading it into memory for every request would be impractical. The server streams it line-by-line using `TextDecoderStream` and extracts all on-demand prices for the target region in a single pass. The results are cached in SQLite. Subsequent requests for the same region are instant. A request deduplication lock prevents concurrent callers from triggering duplicate downloads.

### Pricing Source Transparency

Every `NormalizedPrice` and `CostEstimate` carries a `pricing_source` field. Report consumers can distinguish live prices from interpolated estimates and act accordingly. The `confidence` field (`high`, `medium`, `low`) provides a coarser signal for UI display.

### Single-Pass Aggregation

`CostEngine.calculateBreakdown` fans out all resource calculations concurrently using `Promise.allSettled`. This means the time to produce a full breakdown is bounded by the slowest single resource lookup (typically the first EC2 call for a new region), not the sum of all lookups. Failures for individual resources are logged and skipped; the rest of the breakdown is still returned.

## Configuration System

Configuration is resolved in three layers, each overriding the previous:

```
Built-in defaults (src/types/config.ts)
    |
    v
~/.cloudcost/config.json   (file config)
    |
    v
CLOUDCOST_* environment variables   (highest priority)
```

The merged config is loaded once at startup by `loadConfig()` in `src/config.ts` and passed to every subsystem that needs it. The config object shape is defined in `src/types/config.ts` as `CloudCostConfig`.

Config sections and their keys:

| Section   | Keys                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| `cache`   | `ttl_seconds`, `db_path`                                                      |
| `pricing` | `monthly_hours`, `default_currency`, `include_data_transfer`, `pricing_model` |
| `logging` | `level`                                                                       |
| `parser`  | `resolve_modules`                                                             |
| `budget`  | `monthly_limit`, `per_resource_limit`, `warn_percentage`                      |

See the [Configuration section in README.md](../README.md#configuration) for the full list of environment variable names and their defaults.

## Extension Points

### Adding a New Cloud Provider

1. Implement the `PricingProvider` interface from `src/pricing/pricing-engine.ts`. Each method must return `NormalizedPrice | null` — return `null` when no data is available rather than throwing.
2. Register the adapter in the `PricingEngine` constructor.
3. Add resource type mappings in `src/mapping/` following the existing AWS/Azure/GCP pattern. Update `data/instance-map.json` and `data/storage-map.json`.
4. Add the new provider string to the `CloudProvider` union type in `src/types/resources.ts`.
5. Add resource type sets to `src/calculator/cost-engine.ts` and implement sub-calculator functions for each resource category.
6. If bundled pricing data is needed, add it under `data/` and write a loader following the pattern in `src/pricing/gcp/bundled-loader.ts`.

### Adding a New Resource Type

1. Add the Terraform resource type string to the appropriate `Set` in `src/calculator/cost-engine.ts` (or create a new `Set` for a new category).
2. Implement a calculator function in the relevant file under `src/calculator/` that returns a `CostEstimate`. For types that require a pricing call, use the `PricingEngine` interface.
3. Add a dispatch branch in `CostEngine.calculateCost`.
4. Add the type to `serviceLabel()` in `cost-engine.ts` so it appears under the correct key in `by_service` aggregations.
5. Update the resource type mappings in `src/mapping/` if the resource has cross-provider equivalents.

### Adding a New Output Format

1. Create `src/reporting/your-format-report.ts` and export a function with the signature `(report: ComparisonReport) => string`.
2. Register the format string in the `format` Zod enum in `src/tools/compare-providers.ts`.
3. Add a case in the format dispatch block inside the `compare-providers` handler.

### Adding a New MCP Tool

1. Create `src/tools/your-tool.ts`. Export a Zod schema (conventionally named `yourToolSchema`) and an async handler function.
2. Register it in `src/tools/index.ts` via `server.tool(name, schema.shape, handler)`.
3. The handler must return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
4. Follow the existing tool pattern — the shape is consistent across all seven tools.
5. Add tests covering at least the happy path and one error case.

## Source Layout Reference

```
src/
├── index.ts              Entry point: process error handlers, start server
├── server.ts             MCP server setup, tool registration call
├── config.ts             Three-layer config loader
├── logger.ts             Structured logger (respects CLOUDCOST_LOG_LEVEL)
├── currency.ts           Multi-currency conversion and formatting
├── cli.ts                Optional CLI entry point
├── types/                Shared TypeScript interfaces
│   ├── config.ts         CloudCostConfig, DEFAULT_CONFIG
│   ├── resources.ts      ParsedResource, CloudProvider
│   ├── pricing.ts        NormalizedPrice, CostEstimate, CostBreakdown
│   ├── mapping.ts        ResourceEquivalent, InstanceEquivalent
│   └── reports.ts        ComparisonReport
├── tools/                MCP tool handlers + Zod schemas
├── parsers/              HCL parsing, variable resolution, module expansion
├── pricing/              Provider adapters, cache, interpolation utilities
│   ├── pricing-engine.ts PricingProvider interface + PricingEngine router
│   ├── cache.ts          SQLite-backed NormalizedPrice cache
│   ├── interpolation.ts  interpolateByVcpuRatio, interpolateByStepOrder
│   ├── fetch-utils.ts    Shared HTTP fetch helpers
│   ├── aws/              AwsBulkLoader + normalizer
│   ├── azure/            AzureRetailClient + normalizer
│   └── gcp/              CloudBillingClient + GcpBundledLoader + normalizer
├── calculator/           Per-resource-type cost calculation functions
├── mapping/              Cross-provider resource, instance, storage, region maps
└── reporting/            Markdown, JSON, CSV, FOCUS output formatters

data/
├── instance-map.json     Bidirectional cross-provider resource type mappings
├── storage-map.json      Cross-provider storage type mappings
├── gcp-pricing/          Bundled GCP pricing JSON (fallback when live API fails)
└── instance-types/       Instance type metadata (vCPU, memory, family)
```
