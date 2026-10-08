# Pricing health operations

The daily Health workflow runs at 12:07 UTC. The weekly Refresh Pricing workflow
runs Monday at 12:17 UTC. Both schedules remain subject to GitHub runner and
schedule availability. Inspect the tracking health issue and recent runs;
a successful CI build alone does not establish current pricing or audit health.

During deployment, [Health run 37588000478](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37588000478)
passed freshness, API, drift and audit, but its hosted `gh run list --limit 1`
selected July 13 run 29258028417, ignoring newer successful main refreshes.
The same CLI query with the maintainer token did not reproduce that selection;
the underlying CLI/API response difference is not established. Health now
resolves the active workflow's ID, requests its explicit branch's paginated
[REST history](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow),
validates timestamps and selects by creation time. It records the workflow,
branch, run count and selected commit. It never selects only successful runs
or orders by rerun time, and unknown API/selection failures remain unhealthy.

## Review and merge the refreshed data

Refresh Pricing fetches the configured provider sources, validates coverage and
source vintage, generates tables, builds and tests, then opens or updates
`bot/pricing-refresh`. Review its provider receipts and generated diff before
merging. A rates-unchanged metadata diff is valid only after real successful
retrieval and verification. Source vintage is distinct from retrieval time and
verification time. The 21-day freshness gate is unchanged.

With the existing GITHUB_TOKEN fallback, GitHub can quarantine the PR-event CI
run as `action_required`. An owner must inspect the PR Checks tab and use
**Approve and run**, then wait for the required `ci` check and review before
merging. The independently dispatched CI checks the exact branch commit but
does not release that approval gate. Production PR #52 demonstrated this:
[refresh](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37579173013),
[dispatch CI](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37579299923),
[approved PR-event CI](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37579286447).
Do not add credentials, auto-approve quarantined runs or change protections to
avoid this review requirement. No automatic merge is configured.

GCP pricing generation is owned by this repository. The refresh and daily GCP
smoke steps use the repository's `GCP_PRICING_API_KEY`, restricted to Cloud
Billing API in project `cloudcost-pricing`. Consumer packages need no key.
The generator retrieves every Compute Engine and Cloud Storage catalog page,
then applies pinned Apache-2.0 mappings and machine definitions. There is no
external snapshot build dependency and no Go/Perl/apt dependency. Google API
failure, missing components, changed currency/units, ambiguous mappings and
incomplete pagination leave GCP metadata unchanged and fail the run.

Inspect `sources` for provider effective time, completed retrieval, page/SKU
counts and hashes. `generated_at` records successful snapshot generation;
`verified_at` records consumer validation. `generator_inputs` identifies the
pinned inputs. The 21-day gate still applies. Curated EBS, Azure disk/database
and GCP Cloud SQL tables remain outside automated certification and are
reported separately. See [generator maintenance](../scripts/gcp/README.md).

## Recover a failed refresh

The completion listener diagnoses GitHub jobs and check annotations. It retries
once only when a scheduled default-branch run failed to acquire a hosted runner
before any steps executed. It reruns the failed refresh job and its downstream
CI dispatch. Provider errors, partial execution, forks, successful handoffs and
attempts beyond the first are not automatically replayed. The diagnostic artifact
is written before any rerun request. The listener uses only Actions write,
Checks read and Contents read, with no provider or PR credentials.

To exercise the deployed recovery path without PR or issue writes:

1. Dispatch Refresh Pricing on main with `preview=true` and
   `exercise-recovery=true`. Its first attempt intentionally fails before
   checkout or mutation. The automatic listener rejects this manual event.
2. Without advancing main, dispatch Refresh Pricing Recovery on main with that
   `run-id` and `retry=true`. The controller verifies the exact commit, the
   named probe annotation and that all mutation steps were skipped.
3. Inspect its diagnostic artifact, the second refresh attempt and the
   downstream CI run. The second attempt performs full provider retrieval,
   validation, build and tests. It cannot receive another automatic retry.

The deployed controller was exercised on October 7:
[manual controller](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37582728979)
submitted the single retry,
[refresh attempt 2](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37581414606/attempts/2)
passed, and its
[downstream CI](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37582987593)
passed on the same `ecdc9dcf760880388155d1e0e050de1e28034456` revision.
The [automatic listener](https://github.com/JadenRazo/CloudCostMCP/actions/runs/37581434067)
correctly rejected the first manual failure without retrying it.

Do not use the probe for a production scheduled run. Preview refreshes source
files only on the runner, retains evidence for 14 days and creates no pricing
PR. Test results do not guarantee future provider or GitHub availability.

## Release and verify

Ship through a reviewed version PR, protected main merge and a GitHub release.
The existing publish workflow blocks on a clean install, production audit,
lint, tests, build and freshness; it publishes with provenance and attaches a
CycloneDX SBOM. Keep the package, lockfile and cost-estimate Action pin aligned.
Before release, test the packed artifact in a clean consumer install. After
publication, install that exact registry version into another clean consumer,
audit its production tree and exercise CLI estimates and MCP stdio calls.
Verify the registry gitHead matches the released commit and all default-branch
Health gates pass. Never blindly rerun npm publish after a partial workflow
failure: first check whether the version already exists.
