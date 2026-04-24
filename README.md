<h1 align="center">CloudCost MCP Server</h1>

<p align="center">
  Multi-cloud cost analysis for Terraform, CloudFormation, Pulumi, and Bicep/ARM. Live pricing from AWS, Azure, and GCP.
  <br />
  Built on the <a href="https://modelcontextprotocol.io">Model Context Protocol</a> for seamless AI agent integration.
</p>

<p align="center">
  <a href="https://github.com/jadenrazo/CloudCostMCP/actions/workflows/ci.yml"><img src="https://github.com/jadenrazo/CloudCostMCP/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@jadenrazo/cloudcost-mcp"><img src="https://img.shields.io/npm/v/@jadenrazo/cloudcost-mcp.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js" />
</p>

<p align="right">
  <img src="https://github.com/user-attachments/assets/7d5f613a-851e-4480-900f-438d13f9a56e" alt="CloudCost MCP demo" width="700" />
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

CloudCost MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents parse infrastructure-as-code across multiple formats (Terraform, CloudFormation, Pulumi, Bicep/ARM), query real-time pricing data, and generate multi-cloud cost comparison reports. It connects directly to public pricing APIs from AWS, Azure, and GCP. No API keys or cloud credentials required.

### What it does

- Parses Terraform HCL files, CloudFormation templates, Pulumi stack exports, and Bicep/ARM templates with automatic format detection
- Extracts resource inventories with variable resolution, including referenced modules and OpenTofu `.tofu` files
- Queries live on-demand pricing from AWS Bulk Pricing CSV and Azure Retail Prices REST API; GCP via live Cloud Billing Catalog API with bundled fallback
- Maps equivalent resources across AWS, Azure, and GCP (compute, database, storage, networking, Kubernetes, container registries, secrets management, DNS)
- Generates cost estimates with per-resource breakdowns (monthly and yearly) across multiple currencies
- Compares costs across all three providers side-by-side in markdown, JSON, CSV, or FOCUS format
- Provides optimization recommendations: right-sizing, reserved pricing, provider switching, spot/preemptible instances
- Models hypothetical scenarios (instance type changes, region moves, commitment levels) without modifying Terraform files
- Projects costs over 3, 6, 12, and 36-month horizons with reserved instance comparisons
- Tags resources for cost attribution and groups report output by team, environment, or any custom label
- Posts cost estimate comments to pull requests via a reusable GitHub Actions composite action

### Supported IaC Formats

| Format | Extensions | Auto-detected |
|---|---|---|
| Terraform/OpenTofu | `.tf`, `.tofu` | Yes |
| CloudFormation | `.yaml`, `.yml`, `.json`, `.template` | Yes |
| Pulumi | `.json` (stack export) | Yes |
| Bicep/ARM | `.json` (ARM template) | Yes |

### How this compares to Infracost

Infracost is the mature choice for **Terraform-on-AWS cost estimation in CI** — PR-comment cost deltas, threshold gating, deep Terragrunt support. If that's your workflow, use it.

CloudCostMCP targets a different surface:

- **Agent-native via MCP.** Models call it as a tool *during* generation. `check_cost_budget` returns `allow` / `warn` / `block` with the specific blocking resources named, fast enough on a warm pricing cache for an agent to veto an expensive config before writing it to disk.
- **Multi-IaC in one server.** Terraform, CloudFormation, Pulumi, Bicep/ARM — one tool, not four.
- **Zero credentials.** All pricing comes from public endpoints. No account, no cloud IAM, no API keys.
- **Optimization + what-if scenarios built in.** Right-sizing, reserved-pricing, cross-provider switching, and spot modeling are first-class tools.

The two are complementary. Use Infracost in CI; use CloudCostMCP inside your agent or editor.

---

## Installation

Requires **Node.js 20** or later.

### 60-second quick start (Claude Code)

```bash
npm install -g @jadenrazo/cloudcost-mcp
claude mcp add cloudcost -- cloudcost-mcp
```

Then, inside a project directory with Terraform files, ask Claude:

> *"Use cloudcost to estimate the monthly AWS cost of this Terraform config, then check it against a $2000/month budget with check_cost_budget."*

No API keys, no cloud credentials, no separate account. For other MCP clients (Claude Desktop, Cursor, any MCP-compatible agent), see the detailed setup below.

### All install options

```bash
# From source
git clone https://github.com/jadenrazo/CloudCostMCP.git
cd CloudCostMCP
npm install
npm run build
```

```bash
# Global npm install
npm install -g @jadenrazo/cloudcost-mcp
```

```bash
# One-shot, no install
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

The server exposes twelve MCP tools. Each accepts JSON input and returns structured JSON output. For agent-centric workflows, `check_cost_budget` is the headline tool: it returns an `allow` / `warn` / `block` verdict fast enough to be called between IaC generation and disk write — see [docs/guardrails.md](./docs/guardrails.md).

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
| `currency` | `string` | No | Output currency (default: `USD`). Supports: USD, EUR, GBP, JPY, CAD, AUD, INR, BRL |

### `compare_providers`

Full pipeline: parse Terraform, map resources across providers, fetch pricing, and produce a comparison report. This is the main entry point for cost analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | Terraform files |
| `tfvars` | `string` | No | Variable overrides |
| `format` | `markdown \| json \| csv \| focus` | No | Report format (default: `markdown`) |
| `providers` | `string[]` | No | Providers to compare (default: all three) |
| `currency` | `string` | No | Output currency (default: `USD`). Supports: USD, EUR, GBP, JPY, CAD, AUD, INR, BRL |

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

### `what_if`

Run hypothetical pricing scenarios against existing Terraform resources. Change instance types, regions, providers, or commitment levels and see the cost delta without modifying your actual configuration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | Terraform files |
| `tfvars` | `string` | No | Variable overrides |
| `scenarios` | `object[]` | Yes | Changes to model. Each specifies a resource name and the attributes to override |
| `providers` | `string[]` | No | Providers to evaluate (default: all three) |
| `currency` | `string` | No | Output currency (default: `USD`) |

**Example**: model the cost impact of switching compute from on-demand to spot across providers:

```json
{
  "files": [{ "path": "main.tf", "content": "..." }],
  "scenarios": [
    { "resource": "aws_instance.web", "pricing_model": "spot" },
    { "resource": "aws_instance.app", "instance_type": "m6i.2xlarge" }
  ]
}
```

### `analyze_plan`

Parse terraform plan JSON output for before/after cost-of-change analysis. Shows what resources are being added, changed, or destroyed and the cost impact of each change.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan_json` | `string` | Yes | JSON output from `terraform show -json planfile` |
| `provider` | `aws \| azure \| gcp` | No | Target provider for pricing (auto-detected if omitted) |
| `currency` | `string` | No | Output currency (default: `USD`) |

### `compare_actual`

Parse `.tfstate` files to compare actual infrastructure costs vs estimates. Identifies drift between planned and deployed resources.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `state_json` | `string` | Yes | Contents of a `terraform.tfstate` file |
| `provider` | `aws \| azure \| gcp` | No | Target provider for pricing (auto-detected if omitted) |
| `currency` | `string` | No | Output currency (default: `USD`) |

### `price_trends`

Query historical pricing trends and price change tracking. Shows how pricing has changed over time for specific resource types.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `aws \| azure \| gcp` | Yes | Cloud provider |
| `service` | `string` | Yes | Service category |
| `resource_type` | `string` | Yes | Instance type, storage type, etc. |
| `region` | `string` | Yes | Cloud region |
| `period_days` | `number` | No | Lookback period in days (default: `90`) |

### `detect_anomalies`

Cost anomaly detection with budget checks, price changes, concentration risk, and right-sizing hints. Analyzes parsed resources and flags potential cost issues.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | IaC files to analyze |
| `tfvars` | `string` | No | Variable overrides |
| `provider` | `aws \| azure \| gcp` | No | Target provider (auto-detected if omitted) |
| `budget_monthly` | `number` | No | Monthly budget cap in USD |
| `currency` | `string` | No | Output currency (default: `USD`) |

### `check_cost_budget`

Fast cost-safety guardrail designed for AI agents. Returns `allow` / `warn` / `block` with the specific blocking resources named, so an agent can veto an expensive IaC generation before writing it to disk. Thresholds cascade: per-call params → `CLOUDCOST_GUARDRAIL_*` env → `CLOUDCOST_BUDGET_*` env. See [docs/guardrails.md](./docs/guardrails.md) for integration patterns.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | `{path, content}[]` | Yes | IaC files to evaluate |
| `tfvars` | `string` | No | Variable overrides |
| `provider` | `aws \| azure \| gcp` | No | Target provider (auto-detected if omitted) |
| `region` | `string` | No | Target region (auto-detected if omitted) |
| `currency` | `string` | No | Output currency (default: `USD`) |
| `max_monthly` | `number` | No | Aggregate monthly threshold. Over = `block`. |
| `max_per_resource` | `number` | No | Per-resource threshold. One over = `block`. |
| `warn_ratio` | `number` (0–1) | No | Fraction of limit that triggers `warn` (default `0.8`) |

---

## How Pricing Works

CloudCost uses a tiered approach to get the most accurate pricing available without requiring any API keys or credentials.

### AWS

1. **Live CSV streaming** (primary). For EC2 compute pricing, the server streams the AWS Bulk Pricing CSV for the target region line-by-line. This avoids loading the full ~267 MB file into memory. All on-demand compute prices for the region are extracted in a single pass and cached in SQLite for 24 hours. Concurrent requests for the same region share a single download.

2. **Live JSON API** (secondary). For RDS (~24 MB), S3, ELB, and VPC, the server fetches regional JSON from the [AWS Price List Bulk API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json). These files are small enough to parse directly.

3. **Fallback tables + interpolation**. If live fetching fails (network issues, timeouts), the server falls back to built-in pricing tables covering 85+ EC2 and 29 RDS instance types. A size-interpolation algorithm estimates prices for unlisted sizes within known families by following AWS's predictable doubling pattern (e.g., `large` to `xlarge` doubles the price).

### Azure

1. **Live REST API** (primary). Queries the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) with OData filters for exact SKU matching (`armSkuName`). Fast, free, unauthenticated. Returns precise per-SKU pricing. Results are paginated and fully consumed.

2. **Fallback tables + interpolation**. If the API is unreachable, falls back to built-in tables covering 40+ VM sizes and 14 database tiers. A vCPU-proportional interpolation algorithm estimates prices for unlisted sizes.

### GCP

1. **Live Cloud Billing Catalog API** (primary). Queries the GCP Cloud Billing Catalog API (`cloudbilling.googleapis.com`) using unauthenticated public endpoints. Results are cached for 24 hours.

2. **Bundled pricing data** (fallback). If the live API is unreachable, falls back to curated pricing data in `data/gcp-pricing/` that ships with the package. Covers Compute Engine machine types, Cloud SQL tiers, Cloud Storage classes, and Persistent Disk types across all major regions.

3. **Infrastructure services**. Load balancer, Cloud NAT, and GKE pricing use fixed public rates.

### Pricing Source Transparency

Every price returned includes a `pricing_source` attribute indicating its origin:
- `"live"`: fetched from a public API in real time
- `"fallback"`: from built-in tables (approximate, but reasonable for estimates)
- `"bundled"`: from bundled data files shipped with the package

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
| `CLOUDCOST_INCLUDE_DATA_TRANSFER` | `false` | Include estimated data transfer costs in reports |
| `CLOUDCOST_PRICING_MODEL` | `on_demand` | Default pricing model: `on_demand`, `spot`, or `reserved` |
| `CLOUDCOST_RESOLVE_MODULES` | `true` | Expand referenced Terraform modules during parsing |
| `CLOUDCOST_BUDGET_MONTHLY` | | Monthly budget cap in USD. Triggers a warning when exceeded |
| `CLOUDCOST_BUDGET_PER_RESOURCE` | | Per-resource monthly budget cap in USD |
| `CLOUDCOST_BUDGET_WARN_PCT` | `80` | Percentage of budget at which a warning is surfaced (default: 80%) |
| `CLOUDCOST_GUARDRAIL_MAX_MONTHLY` | | Aggregate monthly ceiling for `check_cost_budget`. Over = `block` verdict |
| `CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE` | | Per-resource ceiling for `check_cost_budget`. One over = `block` verdict |
| `CLOUDCOST_GUARDRAIL_WARN_RATIO` | `0.8` | Fraction of guardrail threshold that triggers `warn` instead of `allow` |

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
              ┌────────────────────────┼───────────────────────┐
              │                        │                       │
    ┌─────────▼─────────┐    ┌─────────▼─────────┐   ┌─────────▼─────────┐
    │   Tool Handlers   │    │   HCL Parsers     │   │   Cost Engine     │
    │ (src/tools/*.ts)  │    │  (src/parsers/)   │   │ (src/calculator/) │
    └─────────┬─────────┘    └───────────────────┘   └─────────┬─────────┘
              │                                                │
    ┌─────────▼────────────────────────────────────────────────▼─────────┐
    │                       PricingEngine (router)                       │
    │                  (src/pricing/pricing-engine.ts)                   │
    └──────┬───────────────────┬─────────────────────┬───────────────────┘
           │                   │                     │
  ┌────────▼───────┐  ┌────────▼───────┐    ┌────────▼───────┐
  │  AWS Bulk      │  │  Azure Retail  │    │  GCP Bundled   │
  │  Loader        │  │  Client        │    │  Loader        │
  │  (CSV + JSON)  │  │  (REST API)    │    │  (static JSON) │
  └────────┬───────┘  └────────┬───────┘    └────────┬───────┘
           │                   │                     │
           ▼                   ▼                     ▼
  AWS Bulk Pricing   Azure Retail API       data/gcp-pricing/
  CSV (public)       (public, no auth)      (bundled files)
```

Highlights: zero API keys (all providers exposed via public endpoints), SQLite-backed price cache shared across tool calls, streaming ingest for the 267 MB AWS bulk CSV, and a graceful live → fallback → interpolated-table chain so every response carries a `pricing_source` and `confidence` field. Full layer-by-layer walkthrough and extension guides in [docs/architecture.md](./docs/architecture.md).

---

## Supported Resources

| Category | AWS | Azure | GCP |
|----------|-----|-------|-----|
| **Compute** | `aws_instance` | `azurerm_virtual_machine`, `azurerm_linux_virtual_machine` | `google_compute_instance` |
| **Database** | `aws_db_instance`, `aws_rds_cluster` | `azurerm_postgresql_flexible_server`, `azurerm_mysql_flexible_server` | `google_sql_database_instance` |
| **Storage** | `aws_ebs_volume`, `aws_s3_bucket` | `azurerm_managed_disk`, `azurerm_storage_account` | `google_compute_disk`, `google_storage_bucket` |
| **Network** | `aws_lb`, `aws_nat_gateway` | `azurerm_lb`, `azurerm_nat_gateway` | `google_compute_forwarding_rule` |
| **Kubernetes** | `aws_eks_cluster` | `azurerm_kubernetes_cluster` | `google_container_cluster` |
| **Container Registries** | `aws_ecr_repository` | `azurerm_container_registry` | `google_artifact_registry_repository` |
| **Secrets Management** | `aws_secretsmanager_secret` | `azurerm_key_vault` | `google_secret_manager_secret` |
| **DNS** | `aws_route53_zone` | `azurerm_dns_zone` | `google_dns_managed_zone` |
| **API Gateway** | `aws_api_gateway_rest_api`, `aws_apigatewayv2_api` | `azurerm_api_management` | `google_api_gateway_api` |
| **WAF** | `aws_wafv2_web_acl` | `azurerm_web_application_firewall_policy` | |
| **OpenSearch** | `aws_opensearch_domain` | | |
| **Messaging** | `aws_sns_topic`, `aws_mq_broker` | `azurerm_servicebus_namespace`, `azurerm_eventhub_namespace` | `google_pubsub_topic` |
| **ML/AI** | `aws_sagemaker_endpoint`, `aws_sagemaker_notebook_instance` | | `google_vertex_ai_endpoint` |

Instance type mapping covers 70+ AWS instance types (including Graviton/ARM families: m6g, m7g, c6g, c7g, r6g, r7g, t4g), 40+ Azure VM sizes, and 20+ GCP machine types with full bidirectional cross-provider mapping.

---

## Limitations

- **On-demand pricing only** by default. Prices reflect pay-as-you-go rates. The `optimize_cost` tool recommends reserved instances; AWS Savings Plans are not yet supported (tracked in [docs/roadmap.md](./docs/roadmap.md)). Pass `pricing_model: "spot"` in `what_if` scenarios to model spot/preemptible pricing.
- **GCP live pricing** is fetched from the Cloud Billing Catalog API with automatic fallback to bundled data when the API is unreachable. Bundled prices may lag slightly behind actual rates.
- **Fallback-data signaling.** When a live pricing API is unreachable and `estimate_cost` / `compare_providers` / `get_pricing` serve data from bundled or fallback tables, the response includes a `warnings` entry ("using fallback/bundled pricing data for …") so callers can flag stale estimates. Bundled data is refreshed weekly via CI.
- **First request latency**. The initial EC2 pricing lookup for a new AWS region may take 30-120 seconds as the CSV file is streamed. Subsequent lookups for the same region are instant (cached for 24 hours).
- **Specialty instance types**. GPU instances (p4d, g5, etc.), high-memory (x2idn), and bare-metal types may fall back to interpolated pricing if not in the built-in tables and live fetch fails.

---

## More docs

- **[docs/guardrails.md](./docs/guardrails.md)** — `check_cost_budget` integration patterns for Claude Code, Cursor, and other agents.
- **[docs/architecture.md](./docs/architecture.md)** — internal layers, design decisions, extension guides.
- **[docs/ci-integration.md](./docs/ci-integration.md)** — GitHub Actions cost-estimate composite action for PR comments.
- **[docs/development.md](./docs/development.md)** — local setup, npm scripts, source layout.
- **[docs/troubleshooting.md](./docs/troubleshooting.md)** — `$0` estimates, slow first request, cache issues, fallback warnings.
- **[docs/roadmap.md](./docs/roadmap.md)** — what's shipped, in flight, backlog, and explicitly not planned.
- **[VERSIONING.md](./VERSIONING.md)** — SemVer-locked public surface and support policy.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — PR guidelines and code style.
- **[SECURITY.md](./SECURITY.md)** — vulnerability reporting.

---

## License

MIT. See [LICENSE](LICENSE) for details.
