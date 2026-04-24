# Versioning & Stability

Starting with v1.0.0, CloudCostMCP follows [Semantic Versioning](https://semver.org/). This document defines the **stable public surface** covered by that guarantee, the change-classification rules that determine major/minor/patch bumps, the support policy, and notes for anyone migrating from v0.x.

## Stable surface (SemVer-locked)

Changes to anything in this section are breaking and require a major version bump.

### MCP tools

The following 12 tools and their input schemas are locked. Their names, required fields, and the type shape of their output are stable. See `src/tools/*.ts` for the Zod schemas.

| Tool                 | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `analyze_terraform`  | Parse Terraform HCL and extract a resource inventory                      |
| `estimate_cost`      | Estimate monthly/yearly cost for a Terraform resource set on one provider |
| `compare_providers`  | Full multi-cloud cost comparison with savings analysis                    |
| `get_equivalents`    | Map Terraform resource types and instance sizes across providers          |
| `get_pricing`        | Direct pricing lookup for a service/resource/region                       |
| `optimize_cost`      | Right-sizing and reserved-pricing recommendations                         |
| `what_if`            | Scenario cost modeling without modifying source files                     |
| `analyze_plan`       | Cost-of-change analysis from a Terraform plan JSON                        |
| `compare_actual`     | `.tfstate` vs planned cost drift detection                                |
| `price_trends`       | Historical pricing trend query                                            |
| `detect_anomalies`   | Budget and concentration-risk anomaly detection                           |
| `check_cost_budget`  | Agent-side cost guardrail with allow/warn/block verdict                   |

### CLI

The `cloudcost-mcp` and `cloudcost` binaries and their documented flags in the README are stable.

### Package entry points

- `main`: `dist/index.js`
- `types`: `dist/index.d.ts`
- `bin`: `cloudcost-mcp`, `cloudcost`
- Node engine: `>=20.0.0`

## Not stable (may change in any release)

- Internal parser implementations under `src/parsers/`
- Pricing adapter internals under `src/pricing/aws`, `src/pricing/azure`, `src/pricing/gcp`
- The on-disk SQLite cache schema (cache is rebuilt on upgrade)
- Bundled fallback pricing tables under `data/`
- Log line format and log levels
- Exit codes beyond `0` (success) and `1` (failure)
- Benchmark scripts and unreleased helper modules

## Change classification

| Change                                           | Bump  |
| ------------------------------------------------ | ----- |
| Remove or rename a tool                          | Major |
| Remove a required input field from a tool schema | Major |
| Change the type of an existing output field      | Major |
| Raise the minimum Node.js version                | Major |
| Add a new tool                                   | Minor |
| Add an optional input field                      | Minor |
| Add a new output field                           | Minor |
| Add a new provider/region/resource               | Minor |
| Bugfix                                           | Patch |
| Performance improvement                          | Patch |
| Pricing data refresh                             | Patch |
| Dependency bump without API change               | Patch |

## Deprecation

Before a tool or field is removed in a future major, it will be marked deprecated in its description for at least one minor release, with the replacement documented in `CHANGELOG.md`.

## Support policy

- The latest minor line receives security and bug fixes.
- The previous minor line receives security fixes only, for 6 months after the next minor is released.
- CVE reports: see [`SECURITY.md`](./SECURITY.md).

## Migration notes

### 0.x → 1.0

**There are no breaking API changes.** v1.0 ratifies the existing v0.5 surface as stable under SemVer. If your integration works on v0.5.x it will work on v1.0.0 without modification.

What v1.0 added beyond the v0.5 surface:

- Formal stability contract (this document).
- Security advisories in transitive dependencies (hono, `@hono/node-server`, path-to-regexp, vite) resolved via npm overrides.
- Smoke integration tests against live provider pricing APIs, runnable via `RUN_INTEGRATION=1` and scheduled weekly in CI.
- Hardened npm publish workflow (tests + audit gate releases).

Node 20 remains the minimum. No change from v0.5.

### Pinning

Once on v1.0 you can safely pin with a caret range:

```json
"@jadenrazo/cloudcost-mcp": "^1.0.0"
```

This accepts bugfixes, pricing refreshes, and additive features, and will not pull in breaking changes.
