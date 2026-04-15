# Migration Guide

## 0.x → 1.0

**There are no breaking API changes.** v1.0 ratifies the existing v0.5 surface as stable under [Semantic Versioning](https://semver.org/). If your integration works on v0.5.x it will work on v1.0.0 without modification.

### What's new in 1.0

- Formal stability contract — see [`STABILITY.md`](./STABILITY.md).
- Security advisories in transitive dependencies (hono, `@hono/node-server`, path-to-regexp, vite) resolved via npm overrides.
- Smoke integration tests against live provider pricing APIs, runnable via `RUN_INTEGRATION=1` and scheduled weekly in CI.
- Hardened npm publish workflow (tests + audit gate releases).

### Locked-in public surface

The following are now SemVer-locked. Any breaking change to them requires a 2.0.

- MCP tools: `analyze_terraform`, `estimate_cost`, `compare_providers`, `get_equivalents`, `get_pricing`, `optimize_cost`, `what_if`, `analyze_plan`, `compare_actual`, `price_trends`, `detect_anomalies`
- CLI binaries: `cloudcost-mcp`, `cloudcost`
- Node engines: `>=20.0.0`

### Node.js

Node 20 remains the minimum. No change from v0.5.

### Support policy going forward

- Latest minor: security + bug fixes.
- Previous minor: security fixes only, 6 months after a new minor ships.
- Deprecations: a tool or input field marked deprecated in a minor must stay for at least one more minor before removal in the next major.

### Pinning

Once on v1.0 you can safely pin with a caret range:

```json
"@jadenrazo/cloudcost-mcp": "^1.0.0"
```

This accepts bugfixes, pricing refreshes, and additive features, and will not pull in breaking changes.
