<p align="center">
  <h1 align="center">CloudCost MCP Server</h1>
  <p align="center">
    Multi-cloud cost analysis for Terraform — powered by live pricing data from AWS, Azure, and GCP.
    <br />
    Built on the <a href="https://modelcontextprotocol.io">Model Context Protocol</a> for seamless AI agent integration.
  </p>
</p>

<p align="center">

![CI](https://github.com/jadenrazo/CloudCostMCP/actions/workflows/ci.yml/badge.svg) [![npm version](https://img.shields.io/npm/v/@jadenrazo/cloudcost-mcp.svg)](https://www.npmjs.com/package/@jadenrazo/cloudcost-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) ![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

</p>

<p align="center">
  <a href="#installation">Installation</a> &nbsp;&bull;&nbsp;
  <a href="#tools">Tools</a> &nbsp;&bull;&nbsp;
  <a href="#how-pricing-works">Pricing</a> &nbsp;&bull;&nbsp;
  <a href="#configuration">Config</a> &nbsp;&bull;&nbsp;
  <a href="#architecture">Architecture</a> &nbsp;&bull;&nbsp;
  <a href="#limitations">Limitations</a>
</p>

---

CloudCost MCP is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server — a standardized way to give AI assistants like Claude access to external tools — that lets AI agents parse Terraform codebases, query real-time pricing data, and generate multi-cloud cost comparison reports. It connects directly to public pricing APIs from AWS and Azure — no API keys or cloud credentials required. GCP pricing is bundled from public catalog data.

### What it does

- Parses Terraform HCL files and extracts resource inventories with variable resolution
- Queries live on-demand pricing from AWS Bulk Pricing CSV and Azure Retail Prices REST API
- Maps equivalent resources across AWS, Azure, and GCP (compute, database, storage, networking, Kubernetes)
- Generates cost estimates with per-resource breakdowns (monthly and yearly)
- Compares costs across all three providers side-by-side in markdown, JSON, or CSV
- Provides optimization recommendations: right-sizing, reserved pricing, provider switching

---

## Installation

Requires **Node.js 20** or later.

```bash
git clone https://github.com/jadenrazo/CloudCostMCP.git
cd CloudCostMCP
npm install
npm run build
```

Or install from npm:

```bash
npm install -g @jadenrazo/cloudcost-mcp
```

Or run directly without installing:

```bash
npx -y @jadenrazo/cloudcost-mcp
```

### Claude Desktop

Add to your Claude Desktop MCP configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cloudcost": {
      "command": "node",
      "args": ["/path/to/CloudCostMCP/dist/index.js"]
    }
  }
}
```

If installed globally via npm:

```json
{
  "mcpServers": {
    "cloudcost": {
      "command": "cloudcost-mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add cloudcost -- node /path/to/CloudCostMCP/dist/index.js
```

Or if installed globally via npm:

```bash
claude mcp add cloudcost -- cloudcost-mcp
```

### As a standalone MCP server (stdio)

```bash
node dist/index.js
```

---

## Tools

The server exposes six MCP tools. Each accepts JSON input and returns structured JSON output.

### `analyze_terraform`

Parse Terraform files and return a resource inventory. Detects the cloud provider, resolves variables (including `tfvars`), and extracts cost-relevant attributes like instance types, storage sizes, and database engines.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | Terraform `.tf` files to analyze |
| `tfvars` | `string` | No | Contents of a `terraform.tfvars` file |

### `estimate_cost`

Calculate costs for parsed resources on a specific provider. Returns monthly and yearly breakdowns per resource with confidence scores.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | Terraform files |
| `tfvars` | `string` | No | Variable overrides |
| `provider` | `aws \| azure \| gcp` | Yes | Target provider for pricing |
| `region` | `string` | No | Target region (auto-mapped if omitted) |

### `compare_providers`

Full pipeline: parse Terraform, map resources across providers, fetch pricing, and produce a comparison report. This is the main entry point for cost analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | Terraform files |
| `tfvars` | `string` | No | Variable overrides |
| `format` | `markdown \| json \| csv` | No | Report format (default: `markdown`) |
| `providers` | `string[]` | No | Providers to compare (default: all three) |

### `get_equivalents`

Look up the equivalent Terraform resource type and instance size across providers. Useful for migration planning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resource_type` | `string` | Yes | Terraform resource type (e.g., `aws_instance`) |
| `source_provider` | `aws \| azure \| gcp` | Yes | Provider the resource belongs to |
| `target_provider` | `aws \| azure \| gcp` | No | Specific target (omit for all) |
| `instance_type` | `string` | No | Instance type to also map (e.g., `t3.large`) |

### `get_pricing`

Direct pricing lookup. Returns the normalized unit price with metadata for a specific resource on a specific provider.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `aws \| azure \| gcp` | Yes | Cloud provider |
| `service` | `compute \| database \| storage \| network \| kubernetes` | Yes | Service category |
| `resource_type` | `string` | Yes | Instance type, storage type, etc. |
| `region` | `string` | Yes | Cloud region |

### `optimize_cost`

Analyze Terraform resources and return optimization recommendations. Includes right-sizing suggestions, reserved instance comparisons, and cross-provider savings opportunities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | Terraform files |
| `tfvars` | `string` | No | Variable overrides |
| `providers` | `string[]` | No | Providers to evaluate (default: all three) |

---

## How Pricing Works

CloudCost uses a tiered approach to get the most accurate pricing available without requiring any API keys or credentials.

### AWS

1. **Live CSV streaming** (primary) — For EC2 compute pricing, the server streams the AWS Bulk Pricing CSV for the target region line-by-line. This avoids loading the full ~267 MB file into memory. All on-demand compute prices for the region are extracted in a single pass and cached in SQLite for 24 hours. Concurrent requests for the same region share a single download.

2. **Live JSON API** (secondary) — For RDS (~24 MB), S3, ELB, and VPC, the server fetches regional JSON from the [AWS Price List Bulk API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json). These files are small enough to parse directly.

3. **Fallback tables + interpolation** — If live fetching fails (network issues, timeouts), the server falls back to built-in pricing tables covering 85+ EC2 and 29 RDS instance types. A size-interpolation algorithm estimates prices for unlisted sizes within known families by following AWS's predictable doubling pattern (e.g., `large` → `xlarge` doubles the price).

### Azure

1. **Live REST API** (primary) — Queries the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) with OData filters for exact SKU matching (`armSkuName`). This is a fast, free, unauthenticated API that returns precise per-SKU pricing. Results are paginated and fully consumed.

2. **Fallback tables + interpolation** — If the API is unreachable, falls back to built-in tables covering 40+ VM sizes and 14 database tiers. A vCPU-proportional interpolation algorithm estimates prices for unlisted sizes.

### GCP

1. **Bundled pricing data** — GCP's Cloud Billing Catalog API requires an API key, so the server ships with curated pricing data in `data/gcp-pricing/`. This covers Compute Engine machine types, Cloud SQL tiers, Cloud Storage classes, and Persistent Disk types across all major regions.

2. **Infrastructure services** — Load balancer, Cloud NAT, and GKE pricing use fixed public rates.

### Pricing Source Transparency

Every price returned includes a `pricing_source` attribute indicating its origin:
- `"live"` — fetched from a public API in real time
- `"fallback"` — from built-in tables (approximate, but reasonable for estimates)
- `"bundled"` — from bundled data files shipped with the package

All pricing data is cached in a local SQLite database (`~/.cloudcost/cache.db`) with a 24-hour TTL to minimize redundant API calls.

---

## Example

Given this Terraform config:

```hcl
# infrastructure.tf
resource "aws_instance" "web" {
  count         = 3
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.xlarge"
}

resource "aws_instance" "app" {
  count         = 2
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "m5.2xlarge"
}

resource "aws_db_instance" "primary" {
  instance_class    = "db.r6g.xlarge"
  engine            = "postgres"
  allocated_storage = 200
}

resource "aws_ebs_volume" "data" {
  count = 5
  size  = 500
  type  = "gp3"
}

resource "aws_s3_bucket" "assets" {}

resource "aws_lb" "main" {
  load_balancer_type = "application"
}

resource "aws_nat_gateway" "main" {}

resource "aws_eks_cluster" "main" {
  name = "prod"
}
```

Running `compare_providers` against that config produces:

```
| Category        | AWS (USD/mo) | Azure (USD/mo) | GCP (USD/mo) |
|-----------------|-------------|----------------|--------------|
| Compute         |   $1,176.48 |      $1,209.60 |    $1,142.88 |
| Database        |     $314.64 |        $297.12 |      $285.48 |
| Storage         |      $48.00 |         $52.80 |       $44.00 |
| Load Balancer   |      $16.20 |         $18.00 |       $18.26 |
| NAT Gateway     |      $32.40 |         $32.40 |       $31.68 |
| Kubernetes      |      $72.00 |         $72.00 |       $72.00 |
| **Total**       | **$1,659.72** | **$1,681.92** | **$1,594.30** |
```

*Prices are on-demand estimates. Actual costs vary by usage, region, and commitment level.*

---

## Configuration

All configuration is optional. The server works out of the box with sensible defaults.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDCOST_CACHE_TTL` | `86400` | Cache TTL in seconds (24 hours) |
| `CLOUDCOST_CACHE_PATH` | `~/.cloudcost/cache.db` | SQLite cache file location |
| `CLOUDCOST_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `CLOUDCOST_MONTHLY_HOURS` | `730` | Hours per month for cost calculations |

### Config File

You can also create `~/.cloudcost/config.json`:

```json
{
  "cache": {
    "ttl_seconds": 43200,
    "db_path": "/tmp/cloudcost-cache.db"
  },
  "pricing": {
    "monthly_hours": 730,
    "default_currency": "USD"
  },
  "logging": {
    "level": "debug"
  }
}
```

Configuration priority: environment variables > config file > built-in defaults.

---

## Architecture

```
                        ┌───────────────────────────────┐
                        │          MCP Client           │
                        │   (Claude Desktop / Agent)    │
                        └──────────────┬────────────────┘
                                       │ stdio
                        ┌──────────────▼────────────────┐
                        │     CloudCost MCP Server      │
                        │        (src/server.ts)        │
                        └──────────────┬────────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              │                        │                         │
    ┌─────────▼─────────┐   ┌─────────▼─────────┐    ┌─────────▼─────────┐
    │   Tool Handlers   │   │   HCL Parsers     │    │   Cost Engine     │
    │  (src/tools/*.ts)  │   │  (src/parsers/)   │    │  (src/calculator/) │
    └─────────┬─────────┘   └───────────────────┘    └─────────┬─────────┘
              │                                                 │
    ┌─────────▼──────────────────────────────────────────────────▼─────────┐
    │                       PricingEngine (router)                        │
    │                   (src/pricing/pricing-engine.ts)                    │
    └───────┬────────────────────┬──────────────────────┬─────────────────┘
            │                    │                      │
  ┌─────────▼──────┐  ┌─────────▼──────┐    ┌──────────▼──────┐
  │  AWS Bulk      │  │  Azure Retail  │    │  GCP Bundled    │
  │  Loader        │  │  Client        │    │  Loader         │
  │  (CSV + JSON)  │  │  (REST API)    │    │  (static JSON)  │
  └───────┬────────┘  └───────┬────────┘    └────────┬────────┘
          │                   │                      │
          ▼                   ▼                      ▼
  AWS Bulk Pricing   Azure Retail API        data/gcp-pricing/
  CSV (public)       (public, no auth)       (bundled files)
```

### Key Design Decisions

- **Zero API keys** — All pricing comes from public endpoints. AWS uses the unauthenticated Bulk Pricing files. Azure uses the free Retail Prices REST API. GCP uses bundled data from public catalog information.
- **SQLite cache** — A single `better-sqlite3` database caches all pricing lookups with configurable TTL. Shared across all tools per server lifetime.
- **Streaming for large files** — AWS EC2 pricing data (~267 MB CSV) is streamed line-by-line rather than loaded into memory. All prices for a region are extracted in one pass and cached.
- **Graceful degradation** — If any live pricing source is unavailable, the server falls back to built-in tables with size-interpolation. Every response includes the pricing source so the consumer knows the confidence level.
- **ESM-only** — Requires Node 20+. All internal imports use `.js` extensions.

---

## Supported Resources

| Category | AWS | Azure | GCP |
|----------|-----|-------|-----|
| **Compute** | `aws_instance`, `aws_launch_template` | `azurerm_virtual_machine`, `azurerm_linux_virtual_machine` | `google_compute_instance` |
| **Database** | `aws_db_instance`, `aws_rds_cluster` | `azurerm_postgresql_flexible_server`, `azurerm_mysql_flexible_server` | `google_sql_database_instance` |
| **Storage** | `aws_ebs_volume`, `aws_s3_bucket` | `azurerm_managed_disk`, `azurerm_storage_account` | `google_compute_disk`, `google_storage_bucket` |
| **Network** | `aws_lb`, `aws_nat_gateway` | `azurerm_lb`, `azurerm_nat_gateway` | `google_compute_forwarding_rule` |
| **Kubernetes** | `aws_eks_cluster` | `azurerm_kubernetes_cluster` | `google_container_cluster` |

Instance type mapping covers 70+ AWS instance types (including Graviton/ARM families: m6g, m7g, c6g, c7g, r6g, r7g, t4g), 40+ Azure VM sizes, and 20+ GCP machine types with full bidirectional cross-provider mapping.

---

## Limitations

- **Data transfer costs** are not included. Inter-region, inter-AZ, and internet egress charges are excluded from estimates.
- **On-demand pricing only** by default. Prices reflect pay-as-you-go rates. The `optimize_cost` tool will recommend reserved instances and savings plans, but base estimates use on-demand.
- **No Terraform module expansion**. Only direct resource blocks in the provided files are parsed. Resources defined inside referenced modules (`source = "..."`) are not resolved.
- **GCP pricing is bundled**, not live. Prices may lag behind actual rates. AWS and Azure pricing is fetched in real time.
- **First request latency**. The initial EC2 pricing lookup for a new AWS region may take 30-120 seconds as the CSV file is streamed. Subsequent lookups for the same region are instant (cached for 24 hours).
- **Specialty instance types**. GPU instances (p4d, g5, etc.), high-memory (x2idn), and bare-metal types may fall back to interpolated pricing if not in the built-in tables and live fetch fails.

---

## Troubleshooting

**$0 cost estimates** — This usually means the instance type string in your Terraform code doesn't match any known pricing data. Check that you're using a real instance type (e.g., `t3.xlarge`) rather than a variable reference that wasn't resolved. Pass your `terraform.tfvars` content via the `tfvars` parameter to resolve variables.

**Slow first request** — The first EC2 pricing lookup for a new region streams the full AWS pricing CSV (~267 MB). This is a one-time cost per region; all subsequent lookups hit the local SQLite cache. Set `CLOUDCOST_LOG_LEVEL=debug` to see progress.

**Cache issues** — Delete `~/.cloudcost/cache.db` to clear all cached pricing data. The cache rebuilds automatically on the next request.

**Node version** — The server requires Node.js 20+. It uses ESM modules, Web Streams API (`TextDecoderStream`), and `AbortSignal.timeout()`.

---

## Development

```bash
npm run dev            # Run with tsx (hot reload, no build needed)
npm test               # Run all tests (vitest)
npm run test:watch     # Watch mode
npm run build          # Production build (tsup → dist/)
npm run lint           # Type check (tsc --noEmit)
```

### Project Structure

```
src/
├── index.ts              # Entry point (process error handlers + start)
├── server.ts             # MCP server setup, tool registration
├── config.ts             # Config loader (defaults → file → env vars)
├── logger.ts             # Structured logger
├── tools/                # MCP tool handlers + Zod schemas
├── parsers/              # HCL parsing, variable resolution
├── pricing/
│   ├── pricing-engine.ts # Router: dispatches to provider adapters
│   ├── cache.ts          # SQLite-backed pricing cache
│   ├── aws/              # Bulk CSV streaming + JSON + fallback
│   ├── azure/            # Retail Prices REST API + fallback
│   └── gcp/              # Bundled pricing data loader
├── calculator/           # Cost calculations per resource type
├── mapping/              # Cross-provider resource/instance mapping
├── reporting/            # Output formatters (markdown, JSON, CSV)
└── types/                # Shared TypeScript interfaces

data/
├── instance-map.json     # Bidirectional instance type mappings
├── storage-map.json      # Cross-provider storage type mappings
├── gcp-pricing/          # Bundled GCP pricing data
└── instance-types/       # Instance type metadata
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
