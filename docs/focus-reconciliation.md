# FOCUS reconciliation for `compare_actual`

`compare_actual` accepts an optional `focus_export` parameter containing a
[FinOps Open Cost and Usage Specification (FOCUS)](https://focus.finops.org/)
billing export. When supplied alongside planned Terraform `files`, the tool
reconciles the *planned estimate* against what the cloud actually billed and
returns a new `actual_vs_estimate_variance` field — a per-resource variance
surface that catches cost mistakes **after** they have happened (complementing
`check_cost_budget`, which catches them before they ship).

## What is FOCUS?

FOCUS is a vendor-neutral schema for cloud billing data. The three major
providers expose FOCUS-compatible exports:

- **AWS** — Cost and Usage Report (CUR) with FOCUS 1.x
  ([docs](https://docs.aws.amazon.com/cur/latest/userguide/cur-create.html))
- **Azure** — Cost Management export with FOCUS format
  ([docs](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/focus-cost-reports))
- **GCP** — Cloud Billing export in FOCUS format
  ([docs](https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables))

All three produce CSV or JSON that `compare_actual` accepts directly — no
pre-processing needed.

## Supported input shapes

`focus_export` accepts either:

- A **CSV string** matching FOCUS column headers (byte cap: 10 MiB).
- A **JSON array** of row objects (row cap: 50 000).

The parser recognises the FOCUS 1.x columns listed below. Unknown columns
become a single `ignored unknown columns: ...` warning; they are not an error.

### Required columns

| Column               | Purpose                                       |
|----------------------|-----------------------------------------------|
| `ResourceId`         | Matched against planned resource identifiers. |
| `EffectiveCost`      | The billed amount for the row's period.       |
| `Currency`           | Must match across rows.                       |
| `BillingPeriodStart` | ISO date for the billed period start.         |
| `BillingPeriodEnd`   | ISO date for the billed period end.           |

### Recognised optional columns

`BillingAccountId`, `ChargeType`, `Provider`, `ServiceName`,
`ServiceCategory`, `ResourceName`, `ResourceType`, `Region`,
`PricingUnit`, `PricingQuantity`, `ListCost`, `ListUnitPrice`.

## Caps & safety posture

- **10 MiB byte cap** on CSV input, **50 000 row cap** on both paths.
  Enforced at schema validation time, before any parsing work.
- **Fail-closed on totals** — rows with non-finite `EffectiveCost` are
  skipped with a warning rather than corrupting totals.
- **User-controlled strings** (resource IDs, column names, currency codes)
  are passed through `sanitizeForMessage` before echo, so the response is
  safe to feed to a downstream LLM.
- **Prototype-pollution guard** on the JSON path — `__proto__`,
  `constructor`, and `prototype` keys are stripped.
- **Zero outbound network** in the parser.

## Currency handling

- The parser rejects mixed currencies across rows with
  `FocusCurrencyMismatchError`.
- `compare_actual` skips variance and surfaces a warning when the export's
  currency does not match the report currency. **It does not auto-convert** —
  auto-conversion would widen trust into the bundled static FX table beyond
  what a reconciliation flow warrants. Export and re-request in the desired
  currency instead.

## Example request

```json
{
  "state_json": "{...terraform.tfstate...}",
  "files": [{ "path": "main.tf", "content": "..." }],
  "focus_export": "BillingAccountId,BillingPeriodStart,...\nacct,2026-04-01,..."
}
```

## Example `actual_vs_estimate_variance` response

```json
{
  "actual_vs_estimate_variance": {
    "total_estimated": 120.50,
    "total_actual": 147.75,
    "total_variance": 27.25,
    "pct": 22.6,
    "top_drivers": [
      {
        "resource_id": "aws_instance.web",
        "estimated": 60.20,
        "actual": 89.40,
        "delta": 29.20,
        "pct": 48.5
      }
    ],
    "missing_actuals": ["aws_ebs_volume.archive"],
    "extra_actuals": ["i-orphan-0001"],
    "warnings": []
  }
}
```

`top_drivers` is capped at 5 entries ordered by `abs(delta)` descending, with
lexicographic tie-break on `resource_id`. `missing_actuals` lists resources
present in the estimate but absent from the FOCUS export; `extra_actuals`
lists FOCUS rows with no matching planned resource (orphaned or renamed).

## Related tools

- [`check_cost_budget`](./guardrails.md) — forward-looking guardrail, catches
  expensive IaC before it is committed.
- `compare_actual` with `focus_export` — backward-looking reconciliation,
  catches cost mistakes that have already been billed.
