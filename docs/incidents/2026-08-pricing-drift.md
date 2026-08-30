# Pricing drift detection gap — August 2026

## Summary

On 2026-08-21, verification work exposed that the live AWS EC2 loader could
overstate common on-demand Linux prices by 2.6x to 7.5x. The repository already
contained a golden-range integration suite that detected the discrepancy, but
the scheduled Health workflow did not invoke it.

The same investigation exposed a second row-selection defect in Azure: a Linux
request for `Standard_D2s_v5` returned the Windows price because the live API's
underscore-style SKU name did not match the selector's expected format.

No usage telemetry is available to quantify affected users or requests. The
correctness blast radius was any uncached estimate that reached the live loader
for an affected SKU; calls that fell back to curated tables used the lower,
correct values.

## Observed impact

The reproduction in [issue #41](https://github.com/JadenRazo/CloudCostMCP/issues/41)
recorded these AWS results in `us-east-1`:

| Instance    | Expected USD/hr | Live result | Error |
| ----------- | --------------: | ----------: | ----: |
| `t3.micro`  |          0.0104 |      0.0780 | 7.50x |
| `m6i.large` |          0.0960 |      0.5760 | 6.00x |
| `t3.medium` |          0.0416 |      0.1092 | 2.63x |

The live Azure query returned both `Standard_D2s_v5` rows in East US: Linux at
$0.096/hr and Windows at $0.188/hr. The client selected Windows for a Linux
request.

## Root cause

### AWS

AWS publishes multiple qualifying-looking Linux rows for one instance type.
The loader wrote each row directly to the same cache key, making upstream CSV
order decide the result. The final unterminated line also bypassed most of the
normal row filters.

The refresh script did not share the defect because it deliberately retained
the minimum price for each instance type.

### Azure

The selector normalized callers to a space-separated fragment such as
`d2s v5`, but the current API returns `skuName: Standard_D2s_v5`. Exact matching
therefore failed. Its fallback sorted by SKU ID and selected the first
on-demand row without preserving the requested operating system.

### Detection and response

`pricing-drift.test.ts` would have detected both problems. It was gated behind
`RUN_INTEGRATION=1`, while Health invoked only files ending in
`.smoke.test.ts`. A null or zero catalog result also produced a warning and a
passing test, so an upstream miss could erase coverage silently.

## Corrective actions

- Parse the complete AWS response, retain the lowest fully filtered price per
  cache key, and then persist the canonical values in one batch.
- Route ordinary and final unterminated CSV lines through the same filter.
- Match Azure VM SKUs punctuation-insensitively using canonical `armSkuName`
  first, and preserve the requested OS in fallback selection.
- Fail golden-range checks on missing or zero prices.
- Run the golden-range suite from scheduled Health and include its result in the
  maintained health issue.
- Re-verify every range against live providers before updating the golden file.

## Verification

On 2026-08-30:

- focused AWS and Azure regression suites: 35/35 passing;
- complete deterministic test suite: 1,564/1,564 passing (51 live-gated tests
  skipped as designed);
- type checking, ESLint, and formatting: passing;
- live cross-provider golden-range suite: 41/41 passing;
- observed `p4d.24xlarge`: $21.957642/hr in `us-east-1` and $21.957640/hr in
  `us-west-2`.

The live suite notes that EBS `gp3` currently falls back to curated data when
the EC2 JSON catalog exceeds the loader's 100 MiB safety cap. That limitation is
explicit rather than presented as live EBS verification.
