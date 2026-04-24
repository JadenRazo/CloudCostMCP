# Documentation

Deep-dive docs for CloudCostMCP. The project [README](../README.md) covers installation, the tool reference, and a 60-second quickstart — this folder is for readers who want more.

| Doc | For you if… |
| --- | --- |
| [architecture.md](./architecture.md) | You want to understand the internal layers (parsers, pricing engine, calculators, reporting) or plan a contribution that extends them. |
| [roadmap.md](./roadmap.md) | You want to see what's shipped, what's in flight, and what has been explicitly not planned. |
| [guardrails.md](./guardrails.md) | You're wiring `check_cost_budget` into a Claude Code or Cursor agent to veto expensive IaC before it's written. |
| [ci-integration.md](./ci-integration.md) | You want to post cost-estimate comments on pull requests via the bundled GitHub Actions composite action. |
| [development.md](./development.md) | You're setting up the project locally — npm scripts, source layout, running a single test. |
| [troubleshooting.md](./troubleshooting.md) | `$0` estimates, slow first requests, cache problems, fallback-pricing warnings. |

For the public API contract and version support policy, see [VERSIONING.md](../VERSIONING.md) at the repo root.
