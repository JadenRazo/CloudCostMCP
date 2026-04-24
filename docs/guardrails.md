# Cost guardrails for AI agents

`check_cost_budget` is a fast MCP tool designed to be called by an agent _between_ generating IaC and writing it to disk. The agent gets back one of three verdicts:

- `allow` — under all thresholds, proceed.
- `warn` — approaching a threshold (default: 80% of limit), surface a heads-up to the user but proceed.
- `block` — over a threshold, do not commit. The response names the blocking resources and why.

This is the counterpart to `detect_anomalies`, which is a heavier post-hoc analysis. Use `check_cost_budget` when speed and a clear binary decision matter more than detail.

## When to call it

The useful moment is after the model produces a candidate IaC snippet but before it is written to the repository. In Claude Code / Cursor / Copilot workflows:

```
agent generates terraform
  → call check_cost_budget(files=[...], max_monthly=X, max_per_resource=Y)
  → if verdict == "block", discard and retry with cost constraints in the prompt
  → if verdict == "warn", write but surface the warning in the response
  → if verdict == "allow", write silently
```

A single call typically completes in well under a second on a cold cache and a few tens of milliseconds once pricing is cached.

## Input

Required-ish: either `max_monthly`, `max_per_resource`, or one of the env vars below. With no thresholds anywhere, the tool returns `allow` with a message explaining why, which is the correct safe default but not useful as a guardrail.

| field | type | notes |
| --- | --- | --- |
| `files` | `{ path, content }[]` | IaC files — Terraform HCL, CloudFormation YAML/JSON, Pulumi stack JSON, or Bicep/ARM JSON. Max 2000 entries, 5 MiB each. |
| `tfvars` | string | Terraform variable overrides. Optional. |
| `provider` | `"aws" \| "azure" \| "gcp"` | Defaults to the provider detected in `files`. |
| `region` | string | Defaults to the region detected in `files`. |
| `currency` | `"USD" \| "EUR" \| …` | Currency for thresholds and output. Default `USD`. |
| `max_monthly` | number (USD/eq.) | Aggregate monthly ceiling. Anything above forces `block`. |
| `max_per_resource` | number | Per-resource monthly ceiling. One expensive resource is enough to trigger `block`. |
| `warn_ratio` | 0–1 | Fraction of the limit at which to emit `warn` instead of `allow`. Default `0.8`. |

## Threshold cascade

Thresholds are resolved in this order, first-match wins:

1. Per-call params (`max_monthly`, `max_per_resource`).
2. `config.guardrail` (populated from `CLOUDCOST_GUARDRAIL_MAX_MONTHLY`, `CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE`, `CLOUDCOST_GUARDRAIL_WARN_RATIO`).
3. `config.budget` (populated from `CLOUDCOST_BUDGET_MONTHLY`, `CLOUDCOST_BUDGET_PER_RESOURCE`).

The response's `thresholds.source` field reports which step won so the agent can explain its decision.

## Output

```jsonc
{
  "verdict": "block",
  "total_monthly": 58423.17,
  "currency": "USD",
  "resource_count": 2,
  "thresholds": {
    "max_monthly": 10000,
    "max_per_resource": 5000,
    "warn_ratio": 0.8,
    "source": "params"
  },
  "reasons": [
    "total $58423.17/mo exceeds threshold $10000.00/mo"
  ],
  "blocking_resources": [
    {
      "resource_id": "aws_instance.ml_cluster_node_1",
      "resource_type": "aws_instance",
      "monthly_cost": 29211.58,
      "threshold": 5000,
      "reason": "$29211.58/mo exceeds per-resource limit $5000.00/mo"
    },
    { "resource_id": "aws_instance.ml_cluster_node_2", "…": "…" }
  ],
  "warning_resources": [],
  "summary": "block: $58423.17/mo across 2 resources; total over threshold $10000.00; 2 resources over per-resource limit"
}
```

`summary` is intentionally a single string — agents can pass it straight through to the user without re-formatting.

## Claude Code integration

Add to `.claude/mcp.json` or the equivalent config file pointed at a `cloudcost-mcp` binary:

```json
{
  "mcpServers": {
    "cloudcost": {
      "command": "cloudcost-mcp",
      "env": {
        "CLOUDCOST_GUARDRAIL_MAX_MONTHLY": "10000",
        "CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE": "5000"
      }
    }
  }
}
```

Then in a `CLAUDE.md` or system prompt:

> When you generate Terraform / CloudFormation / Pulumi / Bicep that provisions paid cloud resources, call `check_cost_budget` with the generated files before writing them. If the verdict is `block`, show the `blocking_resources` to the user and ask whether to proceed, raise the limit, or revise the config.

## Cursor / Copilot Workspace integration

Same shape — register `cloudcost-mcp` as an MCP server in the client's config, export the env vars, and add a rule to the workspace prompt.

## Non-goals

- **Not a policy engine.** There is no OPA-style DSL, no policy storage, no rule chains. If you need attribute-level policy (e.g. "disallow any untagged resource"), run a real policy tool after write.
- **Not CI shift-left.** That is Infracost's niche. Guardrails are an agent-side primitive for the mid-generation decision, not a PR comment bot.
- **Not a replacement for `detect_anomalies`.** Use `detect_anomalies` for the richer post-hoc view (price changes, concentration risk, oversizing hints). `check_cost_budget` is deliberately a single fast decision.

## Failure modes to expect

- **Pricing fallback used.** If the AWS/Azure/GCP pricing APIs are unreachable, the tool uses bundled fallback data. The resulting estimate may be a few percent off. The `estimate_cost` / `get_pricing` tools surface this explicitly; `check_cost_budget` does not (it's a verdict tool, not a reporting tool). If stale-data risk matters, also call `get_pricing` and inspect `fallback_metadata`.
- **Unparseable IaC.** Malformed HCL returns a parse error from the tool. Verdict is undefined in that case — treat as `block` and return the parse error to the user.
- **Zero-resource IaC.** A provider-block-only config has nothing to price; verdict is `allow` with `total_monthly: 0`.
