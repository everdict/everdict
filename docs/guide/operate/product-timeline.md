---
kind: wiki
title: "Products & releases"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/records/product.ts, apps/api/src/api/product/request/create-product.ts, apps/api/src/api/product/request/create-release.ts, apps/api/src/api/product/request/set-release-status.ts, apps/api/src/api/product/product.routes.ts]
---
# Products & releases

The tracker answers *why* you evaluate. The product timeline answers **what you ship** — and puts the
two on one axis, so a score has a version attached to it.

## A product is your real service composition

```bash
curl -XPOST localhost:8787/products \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "Checkout Agent",
  "services": [
    { "name": "api",    "repository": "acme/checkout",        "source": "tags",     "tagPrefix": "api-v", "path": "apps/api" },
    { "name": "worker", "repository": "acme/checkout-worker", "source": "releases" }
  ]
}'
```

Each service reads one stream — GitHub `releases` or `tags` of a repository, optionally narrowed by
`tagPrefix` (a monorepo releases several services from one repository). Versions arrive by pulling that
stream into an **insert-once ledger** — no webhook to configure, and re-syncing never rewrites history.
A background sweep syncs on its own; you can also ask:

```bash
curl -XPOST localhost:8787/products/prd_12/sync -H 'x-everdict-tenant: default'
```

:::warning
`tagPrefix` is the field that fails silently. A typo imports zero versions and reports success, because
"no tags matched" and "no tags exist" look identical from here. The web app's product wizard reads the
repository's real version streams first (`POST /products/discover`) so you pick a prefix instead of
typing one; either way, check `GET /products/:id/versions` after the first sync.
:::

## Watch series — evaluation on the version axis

A **series** is dataset × harness × judges, evaluated automatically when a genuinely new version is
imported (the first sync is a backfill and fires nothing). It is declared on the product:

```json
{ "series": [
  { "key": "retrieval", "label": "Retrieval quality",
    "dataset": { "id": "retrieval-smoke" },
    "harness": { "id": "checkout-agent" },
    "judges":  [{ "id": "tone-rubric" }] }
] }
```

A ref without a `version` means "latest at run time". `POST /products/:id/series/run` evaluates the
series now.

Each resulting scorecard carries `origin: { source: "product", productId, seriesKey, serviceVersion }`
— `seriesKey` is the trend's identity and `serviceVersion` labels each point with the version it measured.
The chart lays points out by time and labels them with versions, so a trend reads as "score per shipped
version" when every run came from a version import; a manual or series-declared run carries no
`serviceVersion`.

## A release is a gate

```bash
curl -XPOST localhost:8787/products/prd_12/releases \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "2026.08",
  "components": [{ "service": "api", "version": "api-v2.4.0" }]
}'
```

Shipping it (`POST /releases/:id/status` with `"status": "released"`) refuses when linked issues are
open, when a watched series **regressed against the previous ship**, or when a series required for
release has not been evaluated — a series gates by default, and opting one out is an explicit
`requiredForRelease: false`. You can pass `"force": true`, and the force is recorded — because "we
shipped over a regression" is a fact worth keeping rather than a state to hide.

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
