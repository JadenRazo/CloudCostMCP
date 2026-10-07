# October 2026 health recovery

Scope: [issue #51](https://github.com/JadenRazo/CloudCostMCP/issues/51),
continuing [PR #49](https://github.com/JadenRazo/CloudCostMCP/pull/49).
No deployment, credential changes, protection changes or automatic merge.

## Confirmed causes

- Main's last committed verification was August 31, beyond the unchanged
  21-day gate. The September 28 refresh completed but its pricing PR was never
  merged. Its log confirms 107 EC2, 29 RDS and 48 Azure VM prices checked
  without price changes, and 3,251 GCP prices from the September 24 snapshot.
  Its six metadata date changes were generated, not manually fabricated.
- The October 5 [refresh run](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37365611606)
  never acquired a runner: job 111949886589 has runner ID 0, no steps, and
  GitHub's failure annotation says it could not acquire a hosted runner after
  multiple attempts. There is no evidence of a provider timeout, concurrency
  cancellation, token failure or user cancellation. Missing logs are consistent
  with no runner execution. The dispatch depended on PR outputs that never
  existed, so its condition correctly skipped it.
- Protection now returns a strict, GitHub Actions-owned required `ci` context
  (app ID 15368), zero required approvals, enforced for administrators.
  PR #49 had only a GitGuardian check in its current rollup. Its historical
  dispatch run passed, but that did not provide the currently required context.
  The PR-event run was `action_required`. No policy or approval was bypassed.
- Production audit of the previous lockfile reproduces one high, one critical
  and two moderate package findings. These are new advisories against the
  previously patched lockfile, not proof that the earlier dependency repair
  failed when it was performed.

## Verified dependency paths and fixes

| Package    | Previous lock | Repaired lock | Dependency path / advisory                                                                                         |
| ---------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| MCP SDK    | 1.30.0        | 1.32.1        | Direct; [OAuth credential issuer advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h), patched from 1.31.0 |
| proxy-addr | 2.0.7         | 2.0.8         | SDK → Express → proxy-addr; [mapped-subnet IP spoofing](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)         |
| fast-uri   | 3.1.7         | 3.1.8         | SDK → AJV → fast-uri; [encoded host case normalization](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj)         |
| ip-address | 10.4.0        | 10.7.3        | SDK → express-rate-limit → ip-address; four moderate advisories below                                              |

The proxy-addr package/advisory mapping matches the authoritative advisory.
The ip-address package-level range combines four advisories with different
patch versions: [link-local classification](https://github.com/advisories/GHSA-rpw4-54j3-4h4q)
and [NAT64 classification](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc)
are patched from 10.5.1; [cross-family subnet comparison](https://github.com/advisories/GHSA-j6r3-76f7-8jcv)
and [unbounded diagnostics](https://github.com/advisories/GHSA-h3mg-xc3c-68pw)
are patched from 10.7.1.

This application starts only stdio, not the SDK OAuth client or Express HTTP
server, and configures no proxy trust. Exploitation is not established.
Nevertheless the shipped dependency tree is patched, without a new override,
suppression or audit-force operation. Existing fast-uri/ip-address override
floors and the SDK minimum were raised within their existing major versions.
The production audit after repair has zero findings, including zero moderate
findings. Regressions exercise proxy trust and forwarded headers, URI and
cross-family IP parsing, and real MCP initialization/tool calls over stdio.

The full CI audit also exposed two development-only high package findings:
ESLint → minimatch → brace-expansion 5.0.9, and coverage/build tooling →
source-map-js 1.2.1. They were patched compatibly to brace-expansion 5.0.12
(raising its existing override floor) and source-map-js 1.2.2, without a new
override or suppression. The authoritative advisories are
[brace rewriting](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr),
[nested brace recursion](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
[comma recursion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), and
[indexed source-map offsets](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
Lint, build and coverage exercise these development paths; the final full
audit is checked in addition to the production gate.

## Pricing provenance

The established `scripts/refresh-pricing.ts --write` pipeline was run against
AWS's public regional EC2/RDS CSVs, Azure's filtered Retail Prices API and the
established gcosts snapshot of Google's Billing Catalog. GCP remains explicitly
a third-party generated snapshot; it is not claimed to be a direct anonymous
Google API retrieval.

Current rates were unchanged. AWS/Azure's `last_updated` records the day current
rates were reconfirmed, while each source receipt records its publication or
selected meter's effective date separately. GCP's `last_updated` remains its
September 24 generation vintage (13 days on October 7), not October 7.
`sources[].retrieved_at` and SHA-256 attest the completed response retrievals;
`verified_at` and `last_verified` advance only after coverage validation,
generation and generated-module validation succeed. The source response
hashes cover the fetched responses, not the generated tables.

AWS streams that fail after enough rows have arrived are now discarded rather
than certified. GCP unknown, future, expired or insufficient source data does
not advance metadata. Source errors remain nonzero while successful providers
can still be written. The 21-day gate and existing coverage floors are preserved.

EBS, Azure disk/database tables and GCP Cloud SQL remain explicitly curated,
outside this automated verification; they are reported by freshness validation.
They are not re-certified by the automated provider stamp.

## Refresh recovery and verification path

The weekly job retains a non-cancelling concurrency group, uses an explicit
Ubuntu 24.04 image, and runs at 12:17 UTC Monday rather than the top of the hour.
A separate completion listener on Ubuntu 22.04 retains GitHub job/annotation
diagnostics and submits at most one failed-job rerun, only for a proven runner
acquisition failure before any steps executed. It does not replay provider
failures, partial writes, successful handoffs, fork events or a second attempt.
The token uses Actions write, Checks read and Contents read only. PR credentials
are not available to recovery and checkout does not persist credentials.

Health's liveness query is scoped to its branch, so a preview on an unmerged
branch cannot make main's refresh loop appear healthy. Failed loop reports now
include run/commit/job/acquisition diagnostics even when runner logs do not exist.

Manual refresh dispatch defaults to preview: providers still fetch, generate,
validate, build and test, and the isolated downstream job dispatches CI on that
same branch. PR, issue and App-token operations are skipped in preview.
`exercise-recovery=true` intentionally stops only the first preview attempt,
before any pricing or PR writes. An exact-commit manual invocation of
`scripts/refresh-recovery.mjs` can safely exercise the real failed-job rerun
and downstream handoff. The second attempt executes the normal full refresh.

The new completion listener cannot receive automatic events until merged:
GitHub requires the workflow file on the default branch. Local policy tests,
workflow linting and the supported manual preview/recovery path validate it
before merge; they do not establish a future scheduled run or repaired main.
The default-branch health issue remains open until a merged revision actually
passes its default-branch health checks.
