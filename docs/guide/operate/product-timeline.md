# Products & releases

The tracker answers *why* you evaluate. The product timeline answers **what you ship** — and puts the
two on one axis, so a score has a version attached to it.

## A product is your real service composition

```bash
curl -XPOST localhost:8787/products \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "Checkout Agent",
  "components": [
    { "name": "api",    "repo": "acme/checkout-api",    "tagPrefix": "v" },
    { "name": "worker", "repo": "acme/checkout-worker", "tagPrefix": "worker-v" }
  ]
}'
```

Versions arrive by pulling GitHub releases and tags into an **insert-once ledger** — no webhook to
configure, and re-syncing never rewrites history:

```bash
curl -XPOST localhost:8787/products/prd_12/sync -H 'content-type: default' -d '{}'
```

:::warning
`tagPrefix` is the field that fails silently. A typo imports zero versions and reports success, because
"no tags matched" and "no tags exist" look identical from here. Check `GET /products/:id/versions`
after the first sync.
:::

## Watch series — evaluation on the version axis

A **series** is dataset × harness × judges, evaluated automatically when a genuinely new version
appears:

```json
{ "seriesKey": "retrieval",
  "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "harness": { "id": "checkout-agent",  "version": "latest" },
  "judges":  [{ "id": "tone-rubric", "version": "latest" }] }
```

Each resulting scorecard carries
`origin: { source: "product", productId, seriesKey, serviceVersion }` — and that `serviceVersion` is
the trend's **x-axis**. The chart is not "score over time"; it is "score per shipped version", which is
the question anyone actually asks.

## A release is a gate

```bash
curl -XPOST localhost:8787/releases \
  -H 'content-type: application/json' -d '{
  "productId": "prd_12", "name": "2026.08",
  "components": [{ "name": "api", "version": "v2.4.0" }]
}'
```

Shipping it refuses when linked issues are open, or when a watch series **regressed against the
previous ship**. You can force it, and the force is recorded — because "we shipped over a regression"
is a fact worth keeping rather than a state to hide.

The ship also freezes what actually went out: each planned component resolves against the version
ledger and the row's id and stream are recorded. So "which v1.0.0 did this release ship?" stays
answerable after a service is repointed at another repository, and a version with no backing row ships
saying it was never resolved rather than pretending.

## One read for the whole axis

```bash
curl localhost:8787/products/prd_12/timeline -H 'x-everdict-tenant: default'
```

Versions, series scores, releases and the issues linked to them — the axis in a single request, which
is what the web timeline draws.

## When not to use it

If you ship one service from one repository and already read its scorecard trend, this adds ceremony.
The value appears when the thing you ship is *several* moving versions and "which of them changed when
the number moved" stops being obvious.

## See also

- [Track the work](tracker.md) — the issues a release gate refuses over
- [`../../architecture/product-timeline.md`](../../architecture/product-timeline.md) — the design record
