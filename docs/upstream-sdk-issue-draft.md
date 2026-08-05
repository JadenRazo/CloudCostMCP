# Draft: upstream issue for @modelcontextprotocol/sdk

> **Status: draft — not yet filed.** Review and file at
> https://github.com/modelcontextprotocol/typescript-sdk/issues when ready.
> Written against `@modelcontextprotocol/sdk@1.30.0`.

---

**Title:** Hard dependencies on Express/Hono HTTP stack impose a CVE surface on stdio-only servers — please make HTTP transports optional

## Problem

The SDK declares its full HTTP server stack as hard `dependencies`, even though a large share of MCP servers (including ours, [CloudCostMCP](https://github.com/JadenRazo/CloudCostMCP)) are **stdio-only** and never import an HTTP transport:

```
express            ^5.2.1
express-rate-limit ^8.2.1
hono               ^4.11.4
@hono/node-server  ^1.19.9 || ^2.0.5
cors               ^2.8.5
raw-body           ^3.0.0
eventsource        ^3.0.2
```

A server that only ever constructs `StdioServerTransport` still installs and ships this entire stack. The code is never loaded at runtime, but it is:

1. **A CVE surface we have to manage anyway.** `npm audit` and scanners (Dependabot, Renovate, Snyk, corporate SCA gates) flag advisories in express / hono / path-to-regexp / body-parser / raw-body regardless of whether the code is reachable. We currently carry npm `overrides` for `hono`, `@hono/node-server`, `path-to-regexp`, `qs`, and `body-parser` purely to keep audit gates green for code we never execute. Each new advisory in the HTTP stack triggers a release-or-explain cycle for every downstream stdio-only server.
2. **Supply-chain bloat.** The transitive closure inflates `node_modules`, SBOM size, and provenance review effort. Our CycloneDX SBOM lists dozens of components whose only reason for existence is an HTTP transport we do not use.
3. **A mismatch with the SDK's own architecture.** The transports are already cleanly separated behind subpath exports (`server/stdio.js` vs `server/streamableHttp.js`, `server/sse.js`, `server/express.js`). The module graph only pulls Express/Hono when an HTTP transport is imported — the coupling exists solely in `package.json`.

## Proposal

Any of the following would resolve this, in rough order of preference:

1. **Move the HTTP stack to `optionalDependencies` / `peerDependencies`** (with `peerDependenciesMeta.optional: true`) and document that HTTP-transport users must install `express`/`hono` themselves. Import-time errors can point at the missing peer.
2. **Split transports into packages** — e.g. `@modelcontextprotocol/sdk` (core + stdio), `@modelcontextprotocol/http-transports` (Express/Hono/SSE). Mirrors how many SDK ecosystems handle heavy optional transports.
3. **Lazy `require` with graceful error** inside the HTTP transport modules, so the deps can at least be pruned (`npm prune --omit=optional`) without breaking stdio users.

## Impact

- Stdio-only servers get a dramatically smaller audit/SBOM surface and stop inheriting HTTP-stack CVE churn.
- HTTP-transport users are unaffected beyond a documented one-line install.

## Environment

- `@modelcontextprotocol/sdk` 1.30.0
- Node.js 24.x
- Server type: stdio-only MCP server (`StdioServerTransport`), no HTTP endpoints

## Workarounds we use today (and why they are unsatisfying)

- npm `overrides` pinning patched versions of `hono`, `@hono/node-server`, `path-to-regexp`, `qs`, `body-parser` — has to be revisited on every advisory.
- Auditing with `--omit=dev` and manually triaging HTTP-stack advisories as "unreachable" — this reasoning does not transfer to automated SCA gates in consuming organizations.
