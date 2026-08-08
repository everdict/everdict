# The product timeline — Product ⊃ Release over an imported version ledger

> The tracker answers "why we evaluate" (docs/tracker.md); the product timeline answers **"what we ship"**:
> the real services that compose the released thing, the versions that moved, the trends the product is
> judged by, and gated releases on top. One axis, drawn by one read.

## The problem it solves

Everdict's results all live at scorecard granularity. A harness references services as an *execution spec*,
but "which composition shipped on which date, and how did quality move between those dates" had no axis: you
could diff two scorecards, but not see a product's story. The timeline is that axis — git one level up: GitHub
releases/issues stay the raw source, and everdict binds them to evaluation evidence.

## The model

- **Product** (`records/product.ts`, aggregate in `@everdict/domain` `product/product.ts`) — mutable state,
  tracker-shaped (NOT a registry entity: it has no immutable versions of its own).
  - `services[]` — the tracked composition. Each names a GitHub repository (`host` for GHE), a `source`
    (`releases` | `tags`), and an optional `tagPrefix` (monorepos release several services from one repo).
    The NAME is the timeline's key; changing a service's source coordinates resets its sync watermark — the
    name now tracks a different stream, and the next sync is a fresh backfill.
  - `series[]` — the watch series: one question asked repeatedly (`dataset × harness × judges`). The `key`
    is the trend's durable identity (scorecards stamp it; relabeling never re-keys history). Capability refs
    default to `latest` — a standing series evaluates whatever is current, which is how it composes with the
    merge→re-pin CI flow (a re-pinned harness instance is picked up with zero coupling). Refs are validated
    against the registries at write time: a dangling id would fail every auto-run and read as "the product
    got worse" instead of "the declaration is broken".
  - `autoEval` — `{enabled, runtime?}`; on by default.
  - `history[]` — the tracker's record-embedded audit trail (`appendHistory`, 200 cap).
- **Release** (`product/release.ts`) — a checkpoint: `planned → released | cancelled`, `targetDate`
  (calendar date), optional `seriesKeys` selection (absent = every series). **`released` is a gate**: the
  transition takes `{openIssues, regressedSeries, force}` (counts supplied by the caller — the tracker's
  rule) and refuses with a 409 naming both while anything blocks; `force: true` ships anyway and is recorded
  on the fact and in the history (event `released`, `forced: true`). A released release is history — it
  cannot reopen. Re-planning a cancelled one is fine.
- **Version ledger** (`ProductServiceVersionRecord`, `everdict_product_service_versions`) — append-only,
  **insert-once by the natural key** `(tenant, productId, service, version)`. The store enforces it
  (`ON CONFLICT DO NOTHING` feeding the outbox CTE), so a re-sync or two racing sweeps can never make one
  version news twice — the dedup is structural, not bookkept. `publishedAt` is the REMOTE clock (tags borrow
  their commit's committer date); the timeline orders by it.

## Sync — everdict stays the client

No inbound webhook (the workspace-scoped-integrations stance). `ProductVersionSync` pulls through the
workspace GitHub App (`tokenForRepository`, `contents: read`) via the narrow `GithubVersionReader` port
(`listReleases` / `listTags` / `commitDate`, adapter beside the repo writer). Triggers:

- **Manual** — `POST /products/:id/sync` (a member presses Sync; MCP `sync_product_versions`).
- **Sweep** — a 15-minute interval in `main.ts` over `ProductStore.listAll`. Not leader-gated: the ledger's
  insert-once makes replica races harmless.

Per-service **soft-fail**: an unreachable repository records `sync.lastError` on that service and the rest
proceed. The watermark (`sync.syncedAt`) is bookkeeping only — correctness comes from the natural key — and
its ONE load-bearing meaning is the backfill discriminator: **a service's first sync backfills the timeline's
past silently** (rows land, no facts, no runs; fifty historical releases are not fifty pieces of news).

## Events + auto-eval

Kinds (registered + axis-classified `work` + trigger-matchable, `records/platform-event.ts`):
`product.created` (observable-only) · `product.service_version_imported` (payload keeps `service` / `version`
/ `repository` top-level so a subscription filters per service) · `release.created` ·
`release.status_changed` (`{from, to, forced?}` — "wake me when we ship" is `to eq released`).

The **auto-eval choke point** lives in the sync (not per transport): after imports, if the product's autoEval
is on and genuinely new (post-watermark) versions landed, submit ONE scorecard per watched series — the
active planned release's selection, else every series — via the `SeriesRunSubmitter` seam (closed over
`ScorecardService.submit` in `main.ts`), as the product's **creator** (the schedule precedent: the standing
declaration's author, not whoever pressed Sync). Failed submits ride the sync outcome (`failedSeries`) —
a silently missing batch would read as "the product got worse".

**Provenance is the trend's x-axis key**: `ScorecardOrigin` gains `productId` / `releaseId?` / `seriesKey` /
`serviceVersion` (`"<service>@<version>"`, the newest arrival of that sync). `ScorecardListFilter` gains
`productId`/`seriesKey` (expression-indexed, mig 0138), so a series chart is a list filter, not a join table.

Harness pins are deliberately untouched: image freshness is the merge→re-pin CI flow's job
(docs/architecture/github-actions-trigger.md); the series runs `harness@latest` and naturally evaluates the
newly pinned instance.

## Readiness + the release axis of regression

`releaseReadiness` (`product/readiness.ts`) is pure arithmetic over what the service fetched: open issues
LINKED to the release (`ISSUE_LINK_TYPES` gained `product`/`release`; links stay unvalidated pointers, the
gate counts through the same reverse query) + each watched series' latest succeeded batch against the
**baseline anchored at the previous released release** ("did we get worse since we last shipped").
Unmeasured never reads as regressed — absence of evidence is not a regression, and a series that has not run
cannot block a release. No stored regression flag on the release (no second regression authority): issue
regression stays the regression watch's, and an issue it reopened blocks the release through the link.

## Reads + surfaces

- `GET /products/:id/timeline?from&to` — the axis in one read (the pulse's treatment: composed from stores
  server-side, drawn by the web): releases + windowed version ledger + per-series points (oldest first, with
  pass rate via `headlinePassRate` and the triggering `serviceVersion`) + linked issues' lifecycle markers.
  Default window 90 days.
- HTTP + MCP full parity in the `api/product` slice; authz reuses the ISSUE pair (`issues:read`/`issues:write`
  — the timeline is the same planning workflow, one axis over); delete = creator-or-admin in the service;
  product deletion cascades releases + ledger (they exist only under their product).
- Web: `/products` (+`/products/new`), `/product/[id]` (services + sync state, release strip, one `LineChart`
  per series — points click through to their scorecard — version table, history), `/release/[id]` (readiness
  card + gate UI: a 409 becomes an explicit forced-ship confirmation). `entities/product` carries the zod
  mirrors + drift guards; the tracker history renderer gained the `released` event.

## Where the code lives

contracts `records/product.ts` + `wire/product/product.ts` · domain `product/{product,release,readiness}.ts` ·
application-control `product/{product-service,product-version-sync}.ts` + `ports/product-store.ts` +
`ports/github-repo-writer.ts` (version reader) · db `product/*` + mig `0138` · api `api/product/*` ·
web `entities/product` + `features/manage-product` + `widgets/product-timeline` + the four routes.
