# Contributing

## Dev setup

Requires Node.js 20+.

```bash
git clone https://github.com/jadenrazo/CloudCostMCP.git
cd CloudCostMCP
npm install
npm run dev   # runs with tsx, no build step needed
```

The server communicates over stdio, so `npm run dev` won't produce visible output unless an MCP client connects. For quick iteration, write unit tests and run those directly.

## Project structure

The codebase is organized into distinct layers — see the Architecture section in the README for the full breakdown. The short version:

- `src/tools/` — MCP tool handlers and their Zod input schemas
- `src/parsers/` — HCL parsing and variable resolution
- `src/pricing/` — Provider-specific pricing fetchers behind a shared interface
- `src/calculator/` — Per-resource-type cost calculation logic
- `src/mapping/` — Cross-provider equivalence tables
- `src/reporting/` — Output formatters (markdown, JSON, CSV)
- `src/types/` — Shared TypeScript interfaces
- `data/` — Bundled GCP pricing, instance maps, storage maps

## Running tests

```bash
npm test                                          # run all tests once
npm run test:watch                                # watch mode
npx vitest run src/path/to/file.test.ts           # single file
```

## Type checking

```bash
npm run lint    # runs tsc --noEmit, no output means clean
```

This must pass before submitting a PR. The project uses TypeScript strict mode — no implicit any, strict null checks, the full set.

## Adding a new MCP tool

1. Create `src/tools/your-tool.ts` — export a Zod schema and an async handler function.
2. Register it in `src/tools/index.ts` via `server.tool(name, schema.shape, handler)`.
3. The handler should return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
4. Follow the pattern in any existing tool — the shape is consistent across all six.
5. Add tests covering at least the happy path and one error case.

## Adding a new cloud provider

1. Implement the `PricingProvider` interface from `src/pricing/pricing-engine.ts`.
2. Register the adapter in the `PricingEngine` constructor.
3. Add resource type mappings in `src/mapping/` following the existing AWS/Azure/GCP patterns.
4. Add type classifications to the resource Sets in `src/calculator/cost-engine.ts`.
5. If the provider needs bundled data (like GCP), add it under `data/`.

## Pull request guidelines

- Keep PRs focused on one thing. A fix and a refactor in the same PR makes review harder than it needs to be.
- New behavior should come with tests. Bug fixes should ideally include a test that would have caught the bug.
- `npm run lint` and `npm test` must both pass.
- Don't leave debug logging or commented-out code in the diff.
- If you're touching pricing logic, note in the PR description how you verified the output numbers.

## Code style

- **ESM only** — all internal imports must use `.js` extensions, even when the source file is `.ts`. This is a Node ESM requirement.
- **Strict TypeScript** — avoid `any`. If you genuinely need an escape hatch, use `unknown` and narrow it.
- **Follow existing patterns** — before writing something new, check if the pattern already exists somewhere in the codebase. The tool handlers, pricing adapters, and calculator dispatch are all consistent by design.
- **No magic values** — constants belong in named variables or config, not scattered inline.
