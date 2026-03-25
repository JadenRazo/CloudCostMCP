# CloudCost MCP — Parallel Feature Implementation Plan

## Overview

This plan adds 15 features to the CloudCost MCP server using parallel agent teams. Features are organized into 4 waves based on dependency order. Within each wave, all agents run simultaneously in isolated git worktrees, then merge to `main` before the next wave starts.

**Merge conflict hotspots** (shared files that multiple features touch):
- `src/calculator/cost-engine.ts` — resource type Sets + dispatch chain
- `src/tools/index.ts` — tool registration
- `src/types/resources.ts` — CloudProvider union, ResourceAttributes
- `src/parsers/resource-extractor.ts` — per-type attribute extractors
- `src/cli.ts` — CLI subcommands
- `src/config.ts` — config fields

**Rule**: Within each wave, no two agents may edit the same file. If two features need the same file, they go in different waves or the same agent handles both.

---

## WAVE 1 — Foundation (No Dependencies)

These features are isolated, touch different files, and unblock later waves.

### Agent 1A: Data Transfer Integration
**Branch**: `feat/data-transfer-integration`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/parsers/resource-extractor.ts`, `src/calculator/cost-engine.ts`, `src/calculator/data-transfer.ts`

**Problem**: The data transfer calculator exists and is routed in `cost-engine.ts`, but uses synthetic resource types (`aws_data_transfer`, `azurerm_data_transfer`, `google_data_transfer`) that never appear in real Terraform. It's unreachable in practice.

**Instructions**:
1. Read `src/calculator/data-transfer.ts` and `src/calculator/cost-engine.ts` fully.
2. The goal is to make data transfer costs appear in real cost estimates by deriving them from existing resources rather than requiring fake resource types.
3. In `cost-engine.ts`, modify `calculateBreakdown()` to generate synthetic data transfer cost line items based on the real resources found. After iterating all resources, examine what providers/regions are present and call the appropriate `calculateXxxDataTransferCost()` with a synthetic resource that has `monthly_egress_gb: 100` (the existing default). This adds a single "data transfer" line item per provider to every cost breakdown.
4. Add a config option `include_data_transfer` (default: `true`) in `src/types/config.ts` under `PricingConfig` so users can toggle this. Read the flag in `calculateBreakdown()`.
5. Add `CLOUDCOST_INCLUDE_DATA_TRANSFER` env var support in `src/config.ts`.
6. Write tests in `src/__tests__/calculator/data-transfer-integration.test.ts` verifying data transfer line items appear in breakdowns when enabled and don't when disabled.
7. Do NOT modify `src/tools/` or `src/reporting/` files.

---

### Agent 1B: OpenTofu Compatibility
**Branch**: `feat/opentofu-compat`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/parsers/hcl-parser.ts`, `src/parsers/index.ts`, tests only

**Instructions**:
1. Read all files in `src/parsers/`.
2. OpenTofu uses identical HCL syntax to Terraform. The parser should already work. The task is to:
   - Add explicit OpenTofu file extension support (`.tofu` files) in the parser's file discovery logic
   - Update `parseTerraform()` in `src/parsers/index.ts` to accept `.tofu` files alongside `.tf` files
   - Check if `hcl-parser.ts` has any Terraform-specific assumptions that would break with OpenTofu
3. In `src/cli.ts`, update the file discovery glob to also find `*.tofu` files (but do NOT add new CLI subcommands).
4. Write tests in `src/__tests__/parsers/opentofu.test.ts` with sample `.tofu` content confirming parsing works identically.
5. Do NOT touch `src/tools/`, `src/calculator/`, `src/pricing/`, `src/types/`, or `src/mapping/`.

---

### Agent 1C: Per-Region Price Variance
**Branch**: `feat/region-pricing`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/pricing/aws/bulk-loader.ts`, `src/pricing/azure/retail-client.ts`, `src/pricing/gcp/bundled-loader.ts`, `data/gcp-pricing/`

**Instructions**:
1. Read all files in `src/pricing/` and `src/pricing/aws/`, `azure/`, `gcp/`.
2. **AWS**: `bulk-loader.ts` already supports per-region pricing via the Bulk API (region is in the CSV/API URL). Verify the region parameter is correctly threaded through all `getComputePrice`, `getDatabasePrice`, etc. calls. If fallback pricing is used, check whether hardcoded prices are US-only. If so, add region-based multipliers for major regions: `eu-west-1` (1.05x), `ap-southeast-1` (1.10x), `ap-northeast-1` (1.12x), `sa-east-1` (1.20x), etc. Add these multipliers as a `const REGION_PRICE_MULTIPLIERS` map.
3. **Azure**: `retail-client.ts` uses the Retail Prices API with `armRegionName` filter. Verify region is threaded correctly. For fallback pricing, add the same multiplier pattern.
4. **GCP**: `bundled-loader.ts` reads from JSON files. The bundled data may have `regions` fields. If prices vary by region in the bundled data, use them. If not, add multipliers as with AWS/Azure.
5. Add a data file `data/region-price-multipliers.json` containing provider → region → multiplier mappings. Load it via `src/data/loader.ts` (add a new accessor function).
6. Write tests in `src/__tests__/pricing/region-variance.test.ts`.
7. Do NOT touch `src/tools/`, `src/calculator/`, `src/types/`, or `src/reporting/`.

---

**Wave 1 merge order**: 1A → 1B → 1C (1A touches `cost-engine.ts` which others don't; 1B touches parsers which others don't; 1C touches pricing which others don't. Clean merges expected.)

---

## WAVE 2 — Core Features (Depends on Wave 1)

### Agent 2A: Live GCP Pricing API
**Branch**: `feat/gcp-live-pricing`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/pricing/gcp/` (new file + modify bundled-loader.ts), `src/pricing/pricing-engine.ts`

**Instructions**:
1. Read `src/pricing/gcp/bundled-loader.ts`, `src/pricing/pricing-engine.ts`, and `src/pricing/aws/bulk-loader.ts` (as a pattern reference).
2. Create `src/pricing/gcp/cloud-billing-client.ts` implementing a client for the GCP Cloud Billing Catalog API (`https://cloudbilling.googleapis.com/v1/services/{serviceId}/skus`). This is a public API, no auth required for listing SKUs.
   - Service IDs: Compute Engine = `6F81-5844-456A`, Cloud SQL = `9662-B51E-5089`, Cloud Storage = `95FF-2EF5-5EA1`, Persistent Disk (under Compute Engine).
   - Implement `fetchComputeSkus(region)`, `fetchDatabaseSkus(region)`, `fetchStorageSkus(region)`.
   - Parse SKU `pricingInfo[0].pricingExpression.tieredRates` to extract per-unit prices.
   - Use `fetchWithRetryAndCircuitBreaker` from `src/pricing/fetch-utils.ts`.
   - Cache results via `PricingCache` (the GcpProvider will now need a cache reference).
3. Modify `src/pricing/pricing-engine.ts`: change `GcpProvider` to accept `cache` parameter. Update the constructor: `new GcpProvider(cache)`.
4. Modify `bundled-loader.ts` to become the fallback. The new `GcpProvider` should try live API first, fall back to bundled data on failure.
5. Create `src/pricing/gcp/gcp-normalizer.ts` updates if needed to normalize SKU data into `NormalizedPrice`.
6. Write tests in `src/__tests__/pricing/gcp-live.test.ts` with stubbed fetch calls.
7. Do NOT touch `src/tools/`, `src/calculator/`, `src/types/`, or `src/reporting/`.

---

### Agent 2B: Terraform Module Expansion
**Branch**: `feat/module-expansion`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/parsers/` (new file + modify index.ts, resource-extractor.ts)

**Instructions**:
1. Read all files in `src/parsers/` fully.
2. Create `src/parsers/module-resolver.ts` that handles `module` blocks in HCL JSON:
   - **Local modules** (`source = "./modules/vpc"`): read `.tf` files from the relative path, recursively parse them via `parseTerraform`, prefix resource IDs with `module.<name>.`
   - **Registry modules** (`source = "terraform-aws-modules/vpc/aws"`): attempt to find locally cached modules in `.terraform/modules/` directory. If found, parse them. If not found, emit a warning and skip.
   - **Git modules** (`source = "git::https://..."`): emit a warning and skip (too complex for initial implementation).
   - Variable pass-through: module block attributes become variable values for the child module. Merge them with the child's variable defaults.
3. Modify `src/parsers/index.ts`: after initial parsing, check for unresolved `module` blocks in the HCL JSON. Call `resolveModules()` and merge the resulting `ParsedResource[]` into the `ResourceInventory`.
4. Add a config option `resolve_modules` (default: `true`) in `src/types/config.ts`.
5. Add `CLOUDCOST_RESOLVE_MODULES` env var in `src/config.ts`.
6. Create test fixtures in `src/__tests__/fixtures/modules/` with a parent and child module. Write tests in `src/__tests__/parsers/module-resolver.test.ts`.
7. Do NOT touch `src/tools/`, `src/calculator/`, `src/pricing/`, or `src/reporting/`.

---

### Agent 2C: Spot / Preemptible Instance Modeling
**Branch**: `feat/spot-pricing`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/calculator/compute.ts`, `src/types/config.ts`, `src/types/pricing.ts`, `src/config.ts`

**Instructions**:
1. Read `src/calculator/compute.ts`, `src/types/config.ts`, `src/types/pricing.ts`, `src/config.ts`.
2. Add a `pricing_model` field to `PricingConfig` in `src/types/config.ts`: `pricing_model: "on-demand" | "spot" | "reserved-1yr" | "reserved-3yr"` (default: `"on-demand"`).
3. Add `CLOUDCOST_PRICING_MODEL` env var in `src/config.ts`.
4. In `src/calculator/compute.ts`, modify `calculateComputeCost()`:
   - If `pricing_model === "spot"`, apply provider-specific discount multipliers: AWS (0.3-0.4x on-demand), Azure (0.3-0.4x), GCP Preemptible (0.2-0.3x) / Spot (0.3-0.4x).
   - Store the discount info in the `CostEstimate.notes` or add a `pricing_model` field to `CostEstimate` in `src/types/pricing.ts`.
   - Mark `pricing_source` as `"spot-estimate"` when using spot pricing.
5. Add spot discount data as a const map in `compute.ts`: `SPOT_DISCOUNT_RANGES` keyed by provider and instance family.
6. Write tests in `src/__tests__/calculator/spot-pricing.test.ts`.
7. Do NOT touch `src/tools/`, `src/pricing/`, `src/parsers/`, or `src/reporting/`.

---

### Agent 2D: Tag-Based Cost Attribution
**Branch**: `feat/tag-attribution`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/reporting/markdown-report.ts`, `src/reporting/json-report.ts`, `src/reporting/csv-report.ts`, `src/types/reports.ts`

**Instructions**:
1. Read all files in `src/reporting/` and `src/types/reports.ts`.
2. `ParsedResource` already has a `tags: Record<string, string>` field populated by the parser.
3. Add a `group_by` option to `ReportOptions` in `src/types/reports.ts`: `group_by?: "resource" | "service" | "tag"` and `group_by_tag_key?: string` (e.g., `"team"`, `"environment"`).
4. In each report formatter:
   - When `group_by === "tag"`, group resources by their `tags[group_by_tag_key]` value. Resources without the tag go in an "Untagged" group.
   - Add a section/table per tag value showing subtotal costs.
   - For JSON: add a `cost_by_tag` object in the output.
   - For CSV: add a `tag_group` column.
   - For Markdown: add a "Cost by Tag" summary table before the detailed breakdown.
5. Write tests in `src/__tests__/reporting/tag-attribution.test.ts` with mock `ProviderComparison` and `ParsedResource[]` data containing varied tags.
6. Do NOT touch `src/tools/`, `src/calculator/`, `src/pricing/`, or `src/parsers/`.

---

### Agent 2E: Multi-Currency Support
**Branch**: `feat/multi-currency`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/tools/compare-providers.ts`, `src/tools/estimate-cost.ts`, new file `src/currency.ts`

**Instructions**:
1. Read `src/tools/compare-providers.ts`, `src/tools/estimate-cost.ts`, and their Zod schemas.
2. Create `src/currency.ts`:
   - Export `SUPPORTED_CURRENCIES` array: `["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "BRL"]`.
   - Export `convertCurrency(amountUsd: number, targetCurrency: string): number`.
   - Use a static exchange rate table (hardcoded, with a comment noting rates as of a specific date). Do NOT call external APIs.
   - Export `formatCurrency(amount: number, currency: string): string` for proper formatting (symbol, decimal places — JPY has 0 decimals, etc.).
3. Add optional `currency` parameter to `estimateCostSchema` and `compareProvidersSchema` Zod schemas (default: `"USD"`).
4. In each tool handler, if `currency !== "USD"`, convert all dollar amounts in the result before returning. Preserve the original USD amounts in a separate field (e.g., `original_usd`).
5. Write tests in `src/__tests__/tools/currency.test.ts`.
6. Do NOT touch `src/calculator/`, `src/pricing/`, `src/parsers/`, or `src/reporting/`.

---

### Agent 2F: Additional Resource Types
**Branch**: `feat/new-resource-types`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/calculator/cost-engine.ts`, `src/parsers/resource-extractor.ts`, `src/mapping/resource-mapper.ts`, `data/resource-equivalents.json`

**Instructions**:
1. Read `src/calculator/cost-engine.ts`, `src/parsers/resource-extractor.ts`, `src/mapping/resource-mapper.ts`, `data/resource-equivalents.json`.
2. Add support for these new resource types:

   **Container Registries**:
   - `aws_ecr_repository`, `azurerm_container_registry`, `google_artifact_registry_repository`
   - Add extractors in `resource-extractor.ts` (extract tier/SKU attributes)
   - Add to `data/resource-equivalents.json` as cross-provider equivalents
   - Add `CONTAINER_REGISTRY_TYPES` Set in `cost-engine.ts`
   - Create `src/calculator/container-registry.ts` with `calculateContainerRegistryCost()` — price by storage (GB/month: AWS $0.10, Azure Basic $0.167/Standard $0.667, GCP $0.10)

   **Secrets Management**:
   - `aws_secretsmanager_secret`, `azurerm_key_vault`, `google_secret_manager_secret`
   - Simple per-secret/per-access pricing (AWS: $0.40/secret/month + $0.05/10K API calls; Azure: varied by tier; GCP: $0.06/version/month)
   - Add `SECRETS_TYPES` Set in `cost-engine.ts`
   - Create `src/calculator/secrets.ts`

   **DNS**:
   - `aws_route53_zone` (add to existing mapping alongside `azurerm_dns_zone`, `google_dns_managed_zone`)
   - Add `DNS_TYPES` Set in `cost-engine.ts`
   - Create `src/calculator/dns.ts` — hosted zone fees (AWS: $0.50/zone, Azure: $0.50/zone, GCP: $0.20/zone) + per-query pricing

3. Add dispatch branches in `cost-engine.ts` `calculateCost()`.
4. Add resource equivalents in `data/resource-equivalents.json`.
5. Write tests for each new calculator.
6. Do NOT touch `src/tools/`, `src/pricing/`, `src/reporting/`, or `src/types/`.

---

**Wave 2 merge order**: 2D → 2E → 2C → 2A → 2B → 2F

Reasoning: 2D only touches reporting. 2E only touches tools. 2C touches types + calculator. 2A touches pricing. 2B touches parsers + types. 2F touches calculator + parsers + mapping — it goes last because it shares `cost-engine.ts` with 2C and `resource-extractor.ts` with 2B.

---

## WAVE 3 — Advanced Features (Depends on Waves 1-2)

### Agent 3A: What-If Analysis Tool
**Branch**: `feat/what-if-tool`
**Type**: `senior-implementation-engineer`
**Files touched**: new `src/tools/what-if.ts`, `src/tools/index.ts`

**Instructions**:
1. Read `src/tools/estimate-cost.ts` and `src/tools/index.ts` for the tool registration pattern.
2. Create `src/tools/what-if.ts`:
   - Zod schema accepts: `terraform_content` (string, the HCL), `changes` (array of `{ resource_id: string, attribute: string, new_value: string | number }`), `provider` (optional), `region` (optional).
   - Handler: parse the terraform content, apply attribute overrides from `changes` array to matching `ParsedResource` objects, run cost estimation on both original and modified resources, return a diff showing per-resource cost change and total delta.
   - Example use case: `changes: [{ resource_id: "aws_instance.web", attribute: "instance_type", new_value: "m5.2xlarge" }]`
3. Register the tool in `src/tools/index.ts` as `what_if` with description "Estimate cost impact of infrastructure changes without modifying Terraform files".
4. Add `what-if` subcommand to `src/cli.ts` that reads a changes JSON file.
5. Write tests in `src/__tests__/tools/what-if.test.ts`.
6. Do NOT touch any existing tool handlers, `src/calculator/`, `src/pricing/`, or `src/reporting/`.

---

### Agent 3B: Budget Alerts / Threshold Warnings
**Branch**: `feat/budget-alerts`
**Type**: `senior-implementation-engineer`
**Files touched**: `src/types/config.ts`, `src/config.ts`, `src/calculator/cost-engine.ts`, `src/types/pricing.ts`

**Instructions**:
1. Read `src/types/config.ts`, `src/config.ts`, `src/calculator/cost-engine.ts`, `src/types/pricing.ts`.
2. Add budget config to `CloudCostConfig` in `src/types/config.ts`:
   ```ts
   budget?: {
     monthly_limit?: number;        // USD threshold
     per_resource_limit?: number;    // per-resource USD threshold
     warn_percentage?: number;       // warn at this % of limit (default: 80)
   }
   ```
3. Add env vars in `src/config.ts`: `CLOUDCOST_BUDGET_MONTHLY`, `CLOUDCOST_BUDGET_PER_RESOURCE`, `CLOUDCOST_BUDGET_WARN_PCT`.
4. Add a `budget_warnings` field to `CostBreakdown` in `src/types/pricing.ts`: `budget_warnings?: string[]`.
5. In `cost-engine.ts` `calculateBreakdown()`, after calculating all costs:
   - Check total monthly cost against `budget.monthly_limit`. If exceeded, add warning string.
   - Check each resource against `budget.per_resource_limit`. If exceeded, add warning string.
   - If cost exceeds `warn_percentage` of limit but not the limit itself, add a softer warning.
6. Write tests in `src/__tests__/calculator/budget-alerts.test.ts`.
7. Do NOT touch `src/tools/`, `src/pricing/`, `src/parsers/`, or `src/reporting/`.

---

### Agent 3C: Cost Projection & Trending
**Branch**: `feat/cost-projection`
**Type**: `senior-implementation-engineer`
**Files touched**: new `src/calculator/projection.ts`, `src/types/pricing.ts`, `src/reporting/markdown-report.ts`

**Instructions**:
1. Read `src/calculator/reserved.ts` (pattern reference), `src/types/pricing.ts`, `src/reporting/markdown-report.ts`.
2. Create `src/calculator/projection.ts`:
   - Export `calculateProjection(monthlyOnDemand: number, reservedOptions: ReservedComparison | null, months: number[]): CostProjection`.
   - `CostProjection` type: `{ projections: { months: number, on_demand_total: number, reserved_total: number | null, savings: number | null }[] }`.
   - For each time horizon (e.g., [3, 6, 12, 36]), calculate cumulative cost at on-demand rate and best reserved rate.
   - Calculate break-even month for reserved vs on-demand.
3. Add `CostProjection` type to `src/types/pricing.ts`.
4. In `src/reporting/markdown-report.ts`, add a "Cost Projection" section at the end of the report that shows a table: `| Timeframe | On-Demand | Reserved | Savings |` for 3/6/12/36 month horizons. Only show this section when reserved pricing data is available.
5. Write tests in `src/__tests__/calculator/projection.test.ts`.
6. Do NOT touch `src/tools/`, `src/pricing/`, `src/parsers/`, or `src/calculator/cost-engine.ts`.

---

### Agent 3D: Resource Dependency Graph
**Branch**: `feat/dependency-graph`
**Type**: `senior-implementation-engineer`
**Files touched**: new `src/parsers/dependency-graph.ts`, `src/tools/analyze-terraform.ts`

**Instructions**:
1. Read `src/parsers/resource-extractor.ts`, `src/tools/analyze-terraform.ts`.
2. Create `src/parsers/dependency-graph.ts`:
   - Export `buildDependencyGraph(resources: ParsedResource[], hclJson: object): DependencyGraph`.
   - `DependencyGraph` type: `{ nodes: { id: string, type: string, estimated_cost?: number }[], edges: { from: string, to: string, relationship: string }[] }`.
   - Parse resource attribute values for references like `aws_instance.web.id`, `azurerm_subnet.main.id` — these indicate dependency edges.
   - Also parse explicit `depends_on` blocks from HCL JSON.
   - Export `generateMermaidDiagram(graph: DependencyGraph): string` that outputs a Mermaid flowchart.
3. Modify `src/tools/analyze-terraform.ts`: add an optional `include_dependencies` boolean parameter to the schema. When true, include the dependency graph and Mermaid diagram in the response.
4. Write tests in `src/__tests__/parsers/dependency-graph.test.ts` with fixtures containing cross-resource references.
5. Do NOT touch `src/calculator/`, `src/pricing/`, `src/reporting/`, or `src/types/`.

---

### Agent 3E: FinOps Export Formats
**Branch**: `feat/finops-export`
**Type**: `senior-implementation-engineer`
**Files touched**: new `src/reporting/focus-report.ts`, `src/reporting/json-report.ts`, `src/types/reports.ts`

**Instructions**:
1. Read `src/reporting/json-report.ts`, `src/reporting/csv-report.ts`, `src/types/reports.ts`.
2. Add `"focus"` to the `ReportFormat` union in `src/types/reports.ts`.
3. Create `src/reporting/focus-report.ts`:
   - Implement the FOCUS (FinOps Open Cost and Usage Specification) format. This is a standardized CSV with specific column names.
   - Required FOCUS columns: `BillingAccountId`, `BillingPeriodStart`, `BillingPeriodEnd`, `ChargeType`, `Provider`, `ServiceName`, `ServiceCategory`, `ResourceId`, `ResourceName`, `ResourceType`, `Region`, `PricingUnit`, `PricingQuantity`, `EffectiveCost`, `ListCost`, `ListUnitPrice`, `Currency`.
   - Map `CostEstimate` fields to FOCUS columns. Use `"estimated"` for `ChargeType`. Set `BillingPeriodStart/End` to current month.
   - Export `generateFocusReport(comparison: ProviderComparison, resources: ParsedResource[]): string`.
4. Update `src/tools/compare-providers.ts`: add `"focus"` to the format enum in the Zod schema and add a case in the format switch.
5. Write tests in `src/__tests__/reporting/focus-report.test.ts`.
6. Do NOT touch `src/calculator/`, `src/pricing/`, `src/parsers/`, or `src/mapping/`.

---

**Wave 3 merge order**: 3C → 3D → 3E → 3A → 3B

Reasoning: 3C touches reporting + types. 3D touches parsers + analyze tool. 3E touches reporting + types + compare tool. 3A touches tools/index.ts + cli.ts. 3B touches types + cost-engine.ts. Ordered to minimize conflict on shared type files.

---

## WAVE 4 — External Integration (Depends on Waves 1-3)

### Agent 4A: GitHub Actions Integration
**Branch**: `feat/github-action`
**Type**: `senior-implementation-engineer`
**Files touched**: new directory `.github/`, new files only

**Instructions**:
1. Read `src/cli.ts` to understand the CLI interface.
2. Create `.github/actions/cost-estimate/action.yml`:
   - A composite GitHub Action that:
     - Sets up Node.js 20
     - Installs the package (`npm install -g @jadenrazo/cloudcost-mcp`)
     - Finds changed `.tf` files in the PR (`git diff --name-only ${{ github.event.pull_request.base.sha }} HEAD -- '*.tf'`)
     - Runs `cloudcost compare <changed-tf-dir> --format markdown` on each unique directory containing changed `.tf` files
     - Posts the markdown output as a PR comment using `gh pr comment`
   - Inputs: `terraform_dir` (optional, override auto-detection), `providers` (default: `"aws,azure,gcp"`), `format` (default: `"markdown"`), `github_token` (required for PR comment)
3. Create `.github/workflows/cost-estimate.yml` as an example workflow file that users can copy.
4. Create `docs/github-action.md` with usage instructions. Do NOT edit the main README — that will be done separately.
5. Write the action to be self-contained with no external dependencies beyond Node.js and the npm package.
6. Do NOT touch any `src/` files.

---

### Agent 4B: GitHub Actions CI for the Project Itself
**Branch**: `feat/ci-pipeline`
**Type**: `senior-implementation-engineer`
**Files touched**: new `.github/workflows/ci.yml`

**Instructions**:
1. Read `package.json` for available scripts.
2. Create `.github/workflows/ci.yml`:
   - Trigger on: push to main, pull requests to main
   - Matrix: Node.js 20.x and 22.x on ubuntu-latest
   - Steps: checkout, setup-node, npm ci, npm run lint (type check), npm test, npm run build
   - Cache npm dependencies
   - Add a separate job for the build artifact: upload `dist/` as artifact
3. Keep it simple and standard. No fancy optimizations.
4. Do NOT touch any `src/` files.

---

**Wave 4 has no merge conflicts** — both agents create new files in `.github/` only.

---

## Execution Instructions for Agent Manager

### Pre-flight
1. Ensure `main` branch is clean: `git status` shows no uncommitted changes.
2. Run `npm test` to confirm all tests pass on the current `main`.
3. Run `npm run build` to confirm clean build.

### Per-Wave Execution

For each wave:

1. **Launch all agents in parallel** using `isolation: "worktree"` so each gets an isolated repo copy.
2. **Each agent must**:
   - Create and checkout its feature branch
   - Implement the feature per its instructions above
   - Run `npm run lint` (type check) — fix any errors
   - Run `npm test` — fix any failures
   - Run `npm run build` — fix any failures
   - Commit all changes with a clear commit message (no AI attribution)
3. **After all agents complete**, merge branches to `main` in the specified merge order:
   - `git checkout main`
   - `git merge --no-ff <branch>` for each branch in order
   - After each merge, run `npm test && npm run build` to catch integration issues
   - If merge conflicts occur, resolve them (the merge order is designed to minimize this)
4. **After all merges**, run the full test suite one final time before starting the next wave.

### Post-implementation
1. Bump version in `package.json` (suggest `0.3.0` for this feature set).
2. Update the README.md feature list to reflect new capabilities.
3. Run `npm test && npm run build` one final time.

### Agent Prompt Template

When launching each agent, use this prompt structure:

```
You are implementing a feature for the CloudCost MCP server (an MCP server for multi-cloud Terraform cost estimation).

**Feature**: [name]
**Branch**: [branch name]
**Goal**: [one-sentence summary]

**Architecture context**:
- MCP server using @modelcontextprotocol/sdk, TypeScript, ESM-only, Node 20+
- Entry: src/index.ts → src/server.ts → src/tools/index.ts
- Parsers in src/parsers/, pricing in src/pricing/, calculators in src/calculator/
- Types in src/types/, mapping in src/mapping/, reporting in src/reporting/
- Tests use vitest, located in src/__tests__/
- All internal imports use .js extensions

**Detailed instructions**:
[paste the per-agent instructions from the plan above]

**Constraints**:
- Do not modify files outside the listed "Files touched"
- Run `npm run lint`, `npm test`, and `npm run build` before committing
- Use clear commit messages, no AI attribution
- Follow existing code patterns and conventions
- ESM imports with .js extensions
- Zod for schema validation in tools
```

---

## Feature Dependency Graph

```
Wave 1 (parallel):
  1A: Data Transfer Integration ──┐
  1B: OpenTofu Compatibility ─────┤── merge to main
  1C: Per-Region Price Variance ──┘
                                  │
Wave 2 (parallel):                ▼
  2A: Live GCP Pricing ──────────┐
  2B: Module Expansion ──────────┤
  2C: Spot/Preemptible ──────────┤── merge to main
  2D: Tag Attribution ───────────┤
  2E: Multi-Currency ────────────┤
  2F: New Resource Types ────────┘
                                  │
Wave 3 (parallel):                ▼
  3A: What-If Tool ──────────────┐
  3B: Budget Alerts ─────────────┤
  3C: Cost Projection ───────────┤── merge to main
  3D: Dependency Graph ──────────┤
  3E: FinOps Export ─────────────┘
                                  │
Wave 4 (parallel):                ▼
  4A: GitHub Action ─────────────┐
  4B: CI Pipeline ───────────────┘── merge to main
```

## Estimated Scope

| Wave | Agents | New Files | Modified Files | New Tests |
|------|--------|-----------|----------------|-----------|
| 1    | 3      | ~3        | ~8             | 3         |
| 2    | 6      | ~7        | ~12            | 6         |
| 3    | 5      | ~5        | ~7             | 5         |
| 4    | 2      | ~4        | 0              | 0         |
| **Total** | **16** | **~19** | **~27** | **14** |
