# CI integration

CloudCostMCP ships a reusable GitHub Actions composite action for posting cost estimates as PR comments.

## What's included

`.github/actions/cost-estimate/` — detects changed `.tf` files in the PR, runs a multi-provider cost comparison, and posts the result as a comment. Skips gracefully when no Terraform changes are present.

## Minimal workflow

```yaml
# .github/workflows/cost-estimate.yml
name: Terraform Cost Estimate

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  cost-estimate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: jadenrazo/CloudCostMCP/.github/actions/cost-estimate@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # terraform_dir: "./terraform"  # auto-detected from changed files
          # providers: "aws,azure,gcp"    # default: all three
          # format: "markdown"            # markdown | json | csv | focus
          # currency: "USD"
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github_token` | required | Used to post the PR comment. `secrets.GITHUB_TOKEN` is sufficient. |
| `terraform_dir` | auto | Path to the Terraform directory. Defaults to the directory of the changed `.tf` files. |
| `providers` | `aws,azure,gcp` | Providers to compare. Narrow to reduce runtime on large configs. |
| `format` | `markdown` | Output format for the comment body. |
| `currency` | `USD` | Output currency. See the `compare_providers` tool for supported codes. |

## Behavior notes

- The action auto-detects the directory containing changed `.tf` files and skips if none are present.
- First run in a repository may take 30–120 s as the AWS bulk CSV streams for the target region. Subsequent runs hit the SQLite cache and return in seconds.
- If you want cost gating (fail the PR when a delta exceeds a threshold), combine the action with a follow-up step that greps the comment body or parses the JSON output.

## For use outside GitHub

GitLab CI, Jenkins, Buildkite: invoke the `cloudcost` CLI (e.g. `cloudcost compare --dir ./terraform --providers aws,azure,gcp`) as a build step and post the output via each platform's native PR-comment mechanism. The composite action is GitHub-specific; the tool itself is not. Note: `cloudcost-mcp` is the stdio MCP server used by agents; `cloudcost` is the CLI with `analyze` / `estimate` / `compare` / `optimize` / `what-if` subcommands.
