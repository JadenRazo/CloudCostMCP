# Troubleshooting

Common friction points and how to resolve them.

## `$0` cost estimates

The instance type string in your Terraform code probably didn't match any known pricing data. Check that you're using a real instance type (e.g., `t3.xlarge`) rather than a variable reference that wasn't resolved. Pass your `terraform.tfvars` content via the `tfvars` parameter to resolve variables.

## Slow first request

The first EC2 pricing lookup for a new region streams the full AWS pricing CSV (~267 MB). One-time cost per region; subsequent lookups hit the local SQLite cache. Set `CLOUDCOST_LOG_LEVEL=debug` to watch progress.

## Cache issues

Delete `~/.cloudcost/cache.db` to clear all cached pricing data. The cache rebuilds automatically on the next request.

## Node version

Requires Node.js 20+. Uses ESM modules, the Web Streams API (`TextDecoderStream`), and `AbortSignal.timeout()`.

## Fallback pricing warnings

When a live pricing source is unreachable, the response carries a `warnings` entry like `"using fallback/bundled pricing data for …"`. That's expected behavior, not a bug — every `NormalizedPrice` also carries a `pricing_source` field (`live` / `fallback` / `bundled`) and a `confidence` field (`high` / `medium` / `low`) so callers can surface the caveat or trigger a retry.

If you want the call to fail closed instead, check `pricing_source` in the response and error at your layer.
