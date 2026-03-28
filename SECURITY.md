# Security Policy

## Reporting a Vulnerability

Report security vulnerabilities through [GitHub Security Advisories](https://github.com/JadenRazo/CloudCostMCP/security/advisories/new).

Do not open a public GitHub issue for security concerns. Security advisories are visible only to the repository maintainers until a fix is released and the advisory is published.

Include in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if applicable)
- The version of CloudCost MCP where you observed the issue

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | Yes       |
| < 0.3.0 | No        |

Only the latest release receives security fixes. Upgrade to v0.3.0 or later before reporting.

## Responsible Disclosure Timeline

| Day | Action                                              |
| --- | --------------------------------------------------- |
| 0   | Vulnerability reported via GitHub Security Advisory |
| 1–3 | Maintainer acknowledges receipt and begins triage   |
| 14  | Target date for a patch or mitigation               |
| 90  | Advisory published regardless of patch status       |

If a fix cannot be delivered within 90 days, the maintainer will coordinate with the reporter on a disclosure plan before the deadline.

## Security Design

CloudCost MCP was designed to operate without access to cloud credentials or user infrastructure. The following properties hold across all versions.

### Zero API Keys Required

All pricing data is fetched from **public, unauthenticated endpoints**:

- **AWS**: Bulk Pricing CSV and JSON files from `pricing.us-east-1.amazonaws.com`. No AWS account or IAM credentials are involved.
- **Azure**: The [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) is a free, unauthenticated REST endpoint.
- **GCP**: The Cloud Billing Catalog API (`cloudbilling.googleapis.com`) is queried without a service account. Bundled JSON files serve as a fallback when the API is unreachable.

The server never reads, requests, or stores cloud provider credentials of any kind.

### No Sensitive Data Storage

The only data written to disk is a local SQLite database at `~/.cloudcost/cache.db` (configurable via `CLOUDCOST_CACHE_PATH`). This database contains **only cached pricing data** sourced from the public APIs listed above. No Terraform source code, resource identifiers, or user-supplied inputs are persisted between requests.

### No Network Egress of User Data

IaC files passed to the MCP tools are **parsed entirely in process**. The HCL parser (`@cdktf/hcl2json`) runs locally via WebAssembly. Terraform content is never transmitted to an external service. The only outbound network traffic the server initiates is to the public pricing endpoints documented above.

### Dependency Minimalism

The server has exactly **four runtime dependencies**:

| Package                     | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `@cdktf/hcl2json`           | HCL-to-JSON parsing (WASM, no native code)          |
| `@modelcontextprotocol/sdk` | MCP stdio transport and tool registration           |
| `better-sqlite3`            | Local SQLite cache (native addon)                   |
| `zod`                       | Input schema validation for all MCP tool parameters |

The only native addon is `better-sqlite3`. All other dependencies are pure JavaScript or WebAssembly.

## Dependency Audit Policy

`npm audit` is run as part of the CI pipeline on every push and pull request targeting `main`. Pull requests that introduce a dependency with a known high or critical vulnerability will not be merged until the vulnerability is resolved.

To audit your local installation:

```bash
npm audit
```

To audit only production dependencies:

```bash
npm audit --omit=dev
```

## Scope

The following are **in scope** for security reports:

- Vulnerabilities in CloudCost MCP source code (`src/`)
- Data leakage through the MCP tool interface
- Cache poisoning via manipulated pricing API responses
- Dependency vulnerabilities with a credible exploitation path

The following are **out of scope**:

- Vulnerabilities in the MCP client (Claude Desktop, Claude Code, etc.)
- Pricing inaccuracies or stale data (these are functional issues, not security issues)
- Issues that require physical access to the machine running the server
