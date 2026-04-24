# Roadmap

Tracks planned work beyond v1.0.x. Grouped by "in flight" (v1.1), "backlog" (not yet scheduled), and "not planned" (explicitly rejected, included so users don't have to ask).

Each in-flight item links back to the tracking issue when one exists. This file is the canonical source; the `CHANGELOG.md` records what actually shipped.

---

## Shipped in v1.1

### Wave 5.0 — Stabilize WIP

Input-bounds test migration, Savings Plans credibility fix in `README.md`, fallback-data signaling, initial roadmap publication. See [CHANGELOG.md](../CHANGELOG.md) for commit-level detail.

### Wave 5.1 — Agent-side cost guardrails

Shipped as the 12th MCP tool: `check_cost_budget`. Returns `{ verdict: "allow" | "warn" | "block", blocking_resources, total_monthly }`. On a warm pricing cache, response is dominated by parse time, not network. Designed to be called by an AI agent between generating IaC and writing it to disk, so a model can't silently commit a $15K/month configuration.

- Promoted the existing `budget_monthly` / `budget_per_resource` primitives from `src/tools/detect-anomalies.ts` into a first-class guardrail tool.
- Env-backed defaults: `CLOUDCOST_GUARDRAIL_MAX_MONTHLY`, `CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE`, `CLOUDCOST_GUARDRAIL_WARN_RATIO`.
- Integration docs for Claude Code / Cursor in [guardrails.md](./guardrails.md).

**Non-goals (intentional):** policy-as-code DSL, persistent policy storage, CI integration (use Infracost for that).

## In flight — v1.1.0

### Wave 5.2 — Real billing-data reconciliation (FOCUS input)

Extend `compare_actual` to accept a FOCUS-formatted billing export (CSV or JSON) as an alternative/additional input. Produces per-resource estimate-vs-actual variance with a "top drivers" ranking.

- New `src/reporting/focus-parser.ts` (inverse of the existing emitter).
- New result field: `actual_vs_estimate_variance: { total_variance, pct, top_drivers: [...] }`.
- Promote `fallback_metadata` from `get_pricing` into structured output on `estimate_cost` + `compare_providers` (today it's only surfaced as a warnings string).

**Non-goals:** live AWS/Azure/GCP billing API integration — that would break the zero-credential promise. Users bring their own FOCUS export.

### Wave 5.3 — FOCUS v1.3 compliance

`src/reporting/focus-report.ts` currently emits 17 columns. FOCUS v1.3 (published Dec 2025) requires ~40 including `BilledCost`, `ContractedCost`, `CommitmentDiscount*`, `SkuId`, `SkuPriceId`. Wave 5.3 closes the gap so `compare_providers --format focus` actually validates.

- Expanded column set populated from existing normalizer outputs.
- CI step runs output through a FOCUS v1.3 JSON-schema validator.
- `docs/focus-compliance.md` maps each required column to our data source.

**Non-goals:** multi-currency FOCUS (we emit USD), adapters from other formats to FOCUS.

### Parallel — Awareness

Runs alongside 5.2 / 5.3. README repositioning ("the first agent-native multi-IaC cost MCP server"), submissions to glama.ai / Smithery / FinOps Foundation MCP registry, a short demo video of `check_cost_budget` blocking a $15K mistake.

---

## Backlog

Items the project wants, in rough priority order, but that are not scheduled into v1.1.

- **AWS Savings Plans support in `optimize_cost`.** AWS Compute Savings Plans can save 17–30% over on-demand, often more than RIs. Not trivial — requires modelling commitment terms, upfront/partial/no-upfront options, and plan-vs-RI comparison logic. Tracked separately because it's a multi-week data-model change, not a single-wave feature.
- **Carbon-intensity overlay.** "Deploying in `eu-west-1` vs `us-east-1` saves N kg CO2/yr at cost difference of $M." Needs a new external data dependency (Electricity Maps / WattTime). Revisit for v1.2 when regulatory pressure (EU AI Act enforcement) forces the requirement.
- **Live RI pricing fetch for AWS.** Today RI discount rates are a static table in `src/calculator/reserved.ts`; the live bulk JSON is multi-GB and wasn't worth streaming. Revisit if a lighter-weight API appears.
- **Expanded resource coverage** — AWS DynamoDB throughput-based pricing (today's estimate is synthetic), Fargate per-task-hour breakdown, Azure ML endpoints, GCP BigQuery / Dataflow / BigTable, GCP Vertex AI (today marked `confidence: low`).
- **Coverage threshold climb** — incremental raises between waves (70 → 75 → 80 → 85) rather than a standalone wave.

---

## Not planned

Included so nobody has to ask.

- **New IaC formats** beyond Terraform / CloudFormation / Pulumi / Bicep/ARM (Terragrunt, Crossplane, Ansible). Depth over breadth.
- **New cloud providers** (OCI, Alibaba, DigitalOcean, IBM, etc.). AWS + Azure + GCP covers the vast majority of production spend; long-tail providers pull effort away from depth work on the primary three.
- **Dashboards, web UI, SaaS offering.** CloudCostMCP is a Model Context Protocol server; UI-layer FinOps tools (CloudHealth, Vantage, Spot.io) are a different product shape.
- **Competing with Infracost on Terraform-on-AWS shift-left PR comments.** Infracost owns that market; differentiation comes from MCP-native workflows, multi-IaC support, and agent-side guardrails, not from copying their GitHub integration.

---

## Process

- Each in-flight wave ships as its own PR, not a long-lived branch.
- Quality gates between waves: `npm test` green, `npm run lint` clean, coverage thresholds hit (see each wave's gate), `code-reviewer` sign-off on any new MCP surface.
- Security-sensitive waves (anything touching `src/tools/*.ts` input schemas or outbound HTTP) get a `security-auditor` pass before merge.
- Backlog items promote to in-flight only when a wave is sized and a clear differentiation reason is written.
