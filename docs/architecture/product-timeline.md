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

`releaseReadiness` (`product/readiness.ts`) composes the SCORECARD GATE's decisions (arch-review 7 P0 — the
product layer never invents truth semantics): open issues LINKED to the release (`ISSUE_LINK_TYPES` gained
`product`/`release`; links stay unvalidated pointers, the gate counts through the same reverse query) + each
watched series' **release verdict** — `analytics.diff` + `evaluateGate` (maxRegressions 0, the `seriesGate`
seam wired at composition) over (latest succeeded batch, **baseline anchored at the previous released
release**), yielding the gate's own vocabulary `pass|block|blocked_missing|not_comparable` plus the product
layer's two orchestration states: `not_evaluated` (no run — which **BLOCKS a required series: not evaluated
is never green**; the pre-verdict arithmetic read absence of evidence as not-regressed, a second and weaker
release constitution under the scorecard gate), `bootstrap_required` (a first ship nobody approved) and
`no_baseline` (an APPROVED first ship — evidence exists, nothing to regress from; passes). Opting a series
out of the gate is the EXPLICIT `ProductSeries.requiredForRelease: false`, never an inference from missing
evidence. `ready = openIssues === 0 && no required series blocks`.

**"No baseline" is four different facts, and the weakest reading used to win** (arch-review 10 P0).
`BaselineResolution` names them: `none_first_ship` · `resolved` · `missing_historical_evidence` (a previous
ship pinned a scorecard that has since been DELETED) · `revision_unavailable` (the pinned scorecard was
RE-SCORED, so the judgment that ship stood on is no longer the one a comparison would read). Collapsed into a
bare `undefined`, all four read as "first ship" — so `allowNoBaseline`, a governance approval to ship the
*first* time, silently licensed shipping after the evidence of the last ship disappeared. Losing the record
of what we shipped against made the gate weaker, which is exactly backwards. `allowNoBaseline` now applies to
`none_first_ship` alone; the two loss states are unconditionally `not_comparable` and no flag opens them.

The SHIP records the per-series DECISION into the release's history entry — both sides with their scoring
pins, whether the series gated, and why. Those pins are the ones the **gate itself** read (`diffSnapshot`
captures both records at its one read), not a separate trend-list read a re-score may have moved between the
two. It also records the product **policy document** it stood on, not just a digest: a digest of a mutable
record detects that the policy changed and can never say what it was, and "which series gated this ship, and
had a bootstrap been approved?" is the first question a post-mortem asks. A forced ship past any blocking
verdict stays a recorded override.

**A release's SCOPE is frozen at plan time** (arch-review 12 P0). A release is "a date and a scope somebody
committed to", and the scope was re-derived from the product's *current* series on every readiness read — so
deleting a series did not FAIL the gate, it DELETED it: `seriesKeys: ["quality"]` filtered against a product
that no longer declares `quality` produced an empty watch list, no blocking series, and `ready: true`. A
bypass sitting underneath every invariant above it, and one no CAS can catch — the decision reads the NEW
product correctly, and the new product is the one missing its gate. `plannedSeriesKeys` + `seriesSelection`
(mig 0152) record the promise; a promised series the product no longer declares is `scope_invalid`, which
blocks unconditionally and does NOT consult `requiredForRelease` (the flag lives on the declaration that
disappeared, so the edit that removed the gate must not also get to decide it never mattered). Under `all`, a
series ADDED after the plan is still watched — more gates is never the unsafe direction. Two layers, on
purpose: `ProductService.update` also REFUSES an edit that would strip a planned release's gate, so the
failure is legible at the edit rather than discovered later as a release nobody can ship — but a preflight
can be bypassed (an import, a migration, another replica), so the gate is the guarantee and the preflight is
the explanation.

**Deleting a product is ONE statement.** Releases and the version ledger exist only under their product and
the schema has no foreign keys by choice, which makes the aggregate boundary a transaction's job.
`removeAggregate` deletes all three in a single data-modifying CTE; the previous application-level walk had a
gap in the middle that a concurrent `createRelease` could insert an orphan into.

**The ship commits against the release's version and the product's POLICY.** `expectStatus` + `expectVersion`
guard the release row (mig 0148); `expectProduct` guards the product's `release_policy_digest` (mig 0154),
evaluated as an `EXISTS` inside the same write statement. A release gate is decided under a policy that lives
in a different aggregate, so the release's own version could never see it move — an admin flipping a series to
required mid-decision left the release row untouched, the guard passed, and the history recorded "required,
not_evaluated" on a release that shipped without a force.

The digest replaced the product's row VERSION (mig 0150's first attempt), which was the right invariant with
the wrong identity: one counter came to mean content revision, release-policy revision AND sync-state
revision, because the store bumps it on every write — including `markServiceSynced`, whose own contract calls
itself bookkeeping. That only became load-bearing once the 15-minute sweep joined the CAS constitution, at
which point a background watermark write conflicted ships whose policy had not moved. Fail-closed is the
right default, and a guard that refuses for reasons an operator cannot connect to the decision is a guard
that gets worked around — a trust risk of its own. The digest covers every series' `{key, required,
allowNoBaseline}`, so renames, icons, service edits and sync watermarks stop conflicting anything; it is
product-wide rather than per-release because the guard is an `EXISTS` on the product row and must compare a
stored value. Legacy rows (NULL digest) fall back to the version guard — sound, over-broad, and self-healing
on that product's next write. The aggregate `version` stays: it is the product's own lost-update guard, a
different question from "is this still the policy I read".
No stored regression flag on the release (no second regression authority): issue regression stays the
regression watch's, and an issue it reopened blocks the release through the link.

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
