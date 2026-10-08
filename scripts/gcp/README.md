# Owned GCP catalog generation

The refresh job uses `GCP_PRICING_API_KEY` (restricted to Cloud Billing API).
Only the refresh step and daily authenticated smoke step receive the secret.
Package users require no key. Project used for quota: `cloudcost-pricing`.

`mapping.csv` is an unmodified copy and `machines.json` selects only this
product's 80 machine definitions from gcosts' `build/gcp.yml`. Both are pinned
to Cyclenerd/google-cloud-pricing-cost-calculator revision
`ac8edd2734343d1f43a759694c7a3569cea6931f` (Apache-2.0, Nils Knieling).
The associated license is preserved in LICENSE. No runtime download or
execution of upstream scripts occurs. Review future mapping changes explicitly.

`src/pricing/gcp/catalog.ts` adapts the required on-demand portion of
`build/pricing.pl` and ordered `build/mapping.sql` rules to TypeScript.
It fetches every page of Compute Engine and Cloud Storage directly from Google,
assembles whole instances including GPUs and bundled local SSD (730h/month),
and preserves the existing consumer's assembled-hourly/monthly schema.
Unneeded Networking, Monitoring, SQL and discount generation is omitted.
There are no Go/Perl tools, SQLite intermediates or apt mirror dependencies.

Retrieval hashes cover length-prefixed response bodies in pagination order.
Receipts record the provider's current-price effective timestamp, page/SKU
counts and completion time. Snapshot generation and consumer verification
have their own timestamps. Historical pricing ranges are never requested.
Missing credentials, failed/truncated pagination, ambiguous mappings, invalid
currency/units, stale effective times and incomplete components fail closed.
The 21-day freshness gate and separately declared curated datasets remain.
