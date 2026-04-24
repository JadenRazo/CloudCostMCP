# Development

Local development reference. See [CONTRIBUTING.md](../CONTRIBUTING.md) for PR guidelines and code style.

## Common commands

```bash
npm run dev            # Run with tsx (hot reload, no build needed)
npm test               # Run all tests (vitest)
npm run test:watch     # Watch mode
npm run build          # Production build (tsup → dist/)
npm run lint           # Type check + eslint
npm run format         # Prettier write
npm run format:check   # Prettier check
npm run bench          # Performance benchmarks
npm run test:coverage  # Coverage report
```

## Source layout

```
src/
├── index.ts              Entry point (process error handlers + server start)
├── server.ts             MCP server setup, tool registration
├── config.ts             Config loader (defaults → file → env vars)
├── logger.ts             Structured logger
├── currency.ts           Multi-currency conversion and formatting
├── cli.ts                Optional CLI entry point
├── tools/                MCP tool handlers + Zod schemas
├── parsers/              HCL parsing, variable resolution, module expansion
├── pricing/              Provider adapters, cache, interpolation
│   ├── aws/              Bulk CSV streaming + JSON + fallback
│   ├── azure/            Retail Prices REST API + fallback
│   └── gcp/              Cloud Billing Catalog API + bundled fallback
├── calculator/           Per-resource-type cost calculation
├── mapping/              Cross-provider resource/instance/region maps
├── reporting/            Markdown, JSON, CSV, FOCUS formatters
├── schemas/              Bounded-input Zod schema constraints
├── types/                Shared TypeScript interfaces
└── util/                 Small shared utilities (sanitize, etc.)

data/
├── instance-map.json               Bidirectional instance type mappings
├── storage-map.json                Cross-provider storage type mappings
├── region-mappings.json            Region name normalization across providers
├── region-price-multipliers.json   Region-level price adjustment factors
├── resource-equivalents.json       Cross-provider resource-type equivalents
├── aws-pricing/                    Bundled AWS pricing snapshots (fallback)
├── azure-pricing/                  Bundled Azure pricing snapshots (fallback)
├── gcp-pricing/                    Bundled GCP pricing data (fallback)
└── instance-types/                 Instance type metadata (vCPU, memory, family)

test/
├── unit/                 Fast unit tests
├── integration/          Cross-layer tests (parse → price → report)
├── fixtures/             Shared test inputs
├── helpers/              Factories and test setup
└── bench/                Performance benchmarks (vitest bench)
```

For the full layer-by-layer walkthrough and extension guides (new provider, new resource type, new output format, new MCP tool), see [architecture.md](./architecture.md).

## Running a single test file

```bash
npx vitest run test/unit/calculator/compute.test.ts
```

## Integration tests against live provider APIs

These are gated behind `RUN_INTEGRATION=1` so they don't run in normal `npm test`. They run weekly in CI:

```bash
RUN_INTEGRATION=1 npm test
```
