---
kind: wiki
title: "The product timeline — Product ⊃ Release over an imported version ledger"
status: current
updated: 2026-08-16
---
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
  - `slug` — how it is ADDRESSED (mig 0169). Derived from the name at creation (`productSlugStem`, unicode
    kept — a workspace naming its products in its own language would otherwise get `product-1`, `product-2`,
    a worse address than the uuid this replaces) and immutable afterwards, for the reason a team key is: an
    address that follows a rename breaks every link that was ever shared. Unique per workspace, and the
    service mints it because uniqueness is a question only the store can answer. Resolution lives in
    `ProductService.get`, so HTTP, MCP and every headless caller take **either form** without learning the
    rule; the discriminator is the ID's shape (uuid → id, anything else → slug), never the slug's, because a
    stored slug today's minting rule would not produce must still resolve. The web canonicalizes at the
    detail route (an id-spelled URL redirects to the slug), the same normalization the issue detail does for
    `ENG-12`.
  - `services[]` — the tracked composition. Each names a GitHub repository (`host` for GHE), a `source`
    (`releases` | `tags`), an optional `tagPrefix` (monorepos release several services from one repo) and an
    optional `path` (where the service lives inside the repository). The NAME is the timeline's key; changing
    a service's source coordinates resets its sync watermark — the name now tracks a different stream, and the
    next sync is a fresh backfill. `path` is deliberately NOT part of `serviceStreamKey`: what a service READS
    is (host, repository, source, tagPrefix), and two services under one repo-wide tag stream genuinely move
    together, so folding the path into the stream identity would declare one stream to be two and would reset
    a watermark for an edit that changed nothing about what is read. Composition, not provenance.
  - `series[]` — the watch series: one question asked repeatedly (`dataset × harness × judges`). The `key`
    is the trend's durable identity (scorecards stamp it; relabeling never re-keys history). Capability refs
    default to `latest` — a standing series evaluates whatever is current, which is how it composes with the
    merge→re-pin CI flow (a re-pinned harness instance is picked up with zero coupling). Refs are validated
    against the registries at write time: a dangling id would fail every auto-run and read as "the product
    got worse" instead of "the declaration is broken".
  - `autoEval` — `{enabled, runtime?}`; on by default.
  - `history[]` — the tracker's record-embedded audit trail (`appendHistory`, 200 cap).
- **Release** (`product/release.ts`) — a checkpoint: `planned → released | cancelled`, `targetDate`
  (calendar date), optional `seriesKeys` selection (absent = every series), optional `components[]` — the
  composition it ships (mig 0162; see §"What a release ships" below). **`released` is a gate**: the
  transition takes `{openIssues, regressedSeries, force}` (counts supplied by the caller — the tracker's
  rule) and refuses with a 409 naming both while anything blocks; `force: true` ships anyway and is recorded
  on the fact and in the history (event `released`, `forced: true`). A released release is history — it
  cannot reopen. Re-planning a cancelled one is fine.
- **Version ledger** (`ProductServiceVersionRecord`, `everdict_product_service_versions`) — append-only,
  **insert-once by the natural key** `(tenant, productId, service, version)`. The store enforces it
  (`ON CONFLICT DO NOTHING` feeding the outbox CTE), so a re-sync or two racing sweeps can never make one
  version news twice — the dedup is structural, not bookkept. `publishedAt` is the REMOTE clock (tags borrow
  their commit's committer date); the timeline orders by it.

## Declaring a product by CHOOSING, not by typing

A service row used to be four text fields, and one of them punishes a mistake silently. `tagPrefix: "api-"`
against a repository whose tags read `api/v1.2.0` matches nothing: the sync reports `imported: 0`, no error is
raised anywhere, and the product's timeline stays empty forever. Every other field fails loudly (a wrong
repository 404s at the first pull); this one fails as *silence*, which is the failure mode this codebase spends
most of its guards removing.

The repository already holds the answer, so `POST /products/discover` (MCP `discover_product_repo`) reads it —
read-only, persisting nothing — and answers the two questions a service row needs:

```
which streams does it PUBLISH   releases first (a published release is the stronger claim), tags as the
                                fallback; prefixes are derived from the real tag names (`versionTagPrefix`)
what does it CONTAIN            the recursive tree filtered to package manifests at component depth
                                (`detectPackages`) — the monorepo half: one product, several subpaths
```

`proposeServices` (pure, in `@everdict/domain`) joins them into the rows the wizard renders as checkboxes.
The distinction that carries the design is `recommended`: a STREAM is evidence (this repository demonstrably
publishes under this prefix, so a service declared on it will import something) and is pre-checked; a PACKAGE
is a candidate (this directory looks deployable) and is offered unchecked *under a repo-wide stream*, or not at
all when there is nothing for it to read — proposing a service with no stream would be inventing one. A
bare-numeric stream is never proposed beside prefixed ones for the same reason in reverse: `tagPrefix:
undefined` means "every tag", so that row would silently swallow the other streams' versions.

The response also carries the version SAMPLE, not just per-prefix counts. That is what lets the wizard re-count
client-side the moment somebody edits a prefix — the preview ("matches 14 versions · 2025-03-01 → 2026-08-01",
or a warning at zero) costs no further GitHub round trip, and uses the sync's own matching rule (`startsWith`,
absent = all) so the number shown is the number that will import. Bounds are declared and reported
(`complete: false` = a read hit its ceiling, making every count a floor); tag dates cost a commit read each, so
only the newest few are resolved.

Creating with "sync now" runs the first sync immediately, which is a BACKFILL: the release history lands
quietly to form the time axis, and nothing is evaluated.

## What a release ships

The product declares WHAT composes it and the ledger records that each service moved; neither answers the
question a release is for — *which versions went out together as 2026.3*. Three services on three streams
produce three independent version rows, and the decision to ship a particular triple is a person's. Deriving
it instead ("the newest import before the ship") invents a composition nobody chose, and keeps re-inventing a
different one as the ledger grows.

`ReleaseRecord.components[]` is `{service, version?}`, validated against the product's tracked services (once
each — two rows for one service are two answers to one question). The version is OPTIONAL: a planned release
legitimately names a service whose version is not cut yet, and "we have not decided" is a different statement
from "v1.2.3". The web picks versions from the imported ledger only (a typed version is a string that joins to
no row), defaulting to the newest import at the moment a service is *included* — including it is the human
decision, the default is a convenience on top.

It is deliberately NOT a gate input. The release gate decides on evidence (open linked issues, watched-series
verdicts); making a half-filled plan un-shippable would be a second, weaker release constitution beside the one
that already exists. The SHIP freezes the composition into its history entry, the same treatment the per-series
decisions get: "which versions did 2026.3 contain" stays answerable from the release itself after the plan has
moved on. Renaming or dropping a service later does not rewrite a shipped release — the record says what
shipped, which is the point of a record.

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

**A series has THREE triggers, and only one of them used to exist.** The import fan-out was the only thing that
ever turned a series into a scorecard, so a series declared on a product whose history was already backfilled
produced nothing at all until upstream happened to ship again — the sync imports no new row, `inserted` is
empty, and the fan-out is skipped. The trend drew "no evaluations in this window" forever, and the same
emptiness reached the release gate as `not_evaluated`, which blocks a required series. A declaration that
silently disables shipping and offers no way to satisfy itself is a missing trigger, not a missing feature.
The fan-out therefore lives in `SeriesEvaluator` (`application-control` `product/series-evaluator.ts`) with
three callers, distinguished by `origin.seriesTrigger`:

```
version_import    the sync's fan-out, on genuinely new post-watermark rows  → submitted as the product's CREATOR
series_declared   the seed a create/edit owes a series it left unanswered   → submitted as the EDITOR
manual            POST /products/:id/series/run — a person asked            → submitted as the CALLER
```

The seed is decided by `seriesNeedingEvidence` (`@everdict/domain`, pure): a series is owed a run when it is
NEW, or when `seriesQuestion` — dataset · harness · judge refs, judges order-insensitive — changed under a
stable key. That second half is the same fact the gate calls `contract_stale`: the key is the TREND's identity
and survives every edit, so it cannot say whether the evidence filed under it still answers the question.
`label`, `requiredForRelease` and `allowNoBaseline` are excluded on purpose — the first is how the question is
spelled, the other two are what we do with its answer. It is deliberately NOT the resolved contract digest:
that one needs the registries and catches a floating `latest` moving under an unchanged declaration, which is
why the *gate* compares it; this is the pure half a WRITE can recognize with no I/O.

The seed is best-effort and `autoEval.enabled` gates it (it is the automatic half); the write has already
landed and must not be undone by a batch that could not be submitted. That is not a silent failure here, which
is the whole reason it is allowed to be soft: the series draws an empty trend beside an explicit run control,
and a required one keeps blocking the release until somebody presses it. The manual run honours no such
switch — auto-eval governs what happens *without* a person, and a control that quietly does nothing is worse
than no control. A named key the product does not declare is a 404, never a silently empty fan-out.

**Provenance is the trend's x-axis key**: `ScorecardOrigin` gains `productId` / `releaseId?` / `seriesKey` /
`seriesTrigger` / `serviceVersion` (`"<service>@<version>"`, the newest arrival of that sync — stamped ONLY by
an import, because only that trigger has a cause; "ran because of v2.1.0" and "ran while v2.1.0 was current"
are different claims, and a lane drawing them identically asserts the stronger one). `ScorecardListFilter`
gains `productId`/`seriesKey` (expression-indexed, mig 0138), so a series chart is a list filter, not a join
table.

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

**Evidence must answer the question the series asks NOW** (arch-review 13 P0). `seriesKey` is the TREND's
identity — deliberately stable so relabeling never re-keys history — and readiness selected release evidence
by it, so editing a series' dataset/harness/judges left yesterday's green standing as today's evidence: same
key, different question. Worse for version-less refs, where `latest` moves with the product row untouched, so
neither the row version nor the policy digest could ever see it. A series is therefore two things and gets two
identities: `key` (the trend) and `seriesContractDigest` (the CONTRACT). The contract is the resolved
TRANSITIVE closure, not the top documents: `harness@1` is a document that may name `model: {ref}` with no
version, so the same declaration can execute under a different model with every id/version above reading
held. It seals what the scorecard manifest seals — and seals it with the manifest's OWN FUNCTIONS
(`resolveSeriesContract` over `sealHarnessModelClosure`/`sealJudgeClosure`, arch-review 15 P1-5), because a
hand-rolled second resolver is not merely a duplicate: it drifts into a SUBSET, and a subset that reads
"held" is a false assurance at the one moment a release decides to ship. The one it replaced had already
drifted — no service models (so every service-topology product's model closure resolved to nothing), no
delegated harness for a harness judge (so the entire agent rendering the verdict could be swapped), no spec
digest (so a tenant-local `x@1` shadowing the `_shared` `x@1` read as the same document), no `judgeRun` (so a
workspace switching its default judge model changed what every inline score means, invisibly).

The seam is ONE RESOLUTION with TWO POLICIES over a hole, which is the part worth remembering:

```
manifest   records a fact about an execution that HAPPENED — a hole is recorded honestly ("unresolved")
           and the batch still runs, because refusing there would lose the run entirely
gate       asks whether the current question's identity is ESTABLISHED — a hole is not an answer, so any
           "unresolved" sentinel (or an unreadable spec) makes the whole contract `unresolvable`
```

So a new closure facet reaches the release gate the moment it reaches the manifest. `seriesContractFromManifest`
projects a manifest back onto the contract shape and TRUST-63 requires the two digests to agree, so the
correspondence is certified rather than remembered.

The contract names the DOCUMENTS, not just their references (arch-review 16 P0-2): `dataset.digest` and
`harness.specDigest` ride it, for the same reason the judge closure already carried `specDigest`. The registry
resolves owner-first over a `_shared` fallback, so a workspace registering its own `support@1` or `agent@1`
substitutes different bytes with the id AND the version string both reading held — a shadowed dataset can
change every case's task, environment, timeout and default graders, and a shadowed harness can change its
script and topology while its model closure coincidentally matches. `support@1 == support@1` was a structural
blind spot in the one comparison that decides whether a release ships.

And SHARING THE RESOLVER IS NOT CARRYING THE RESOLUTION (arch-review 16 P0-3). The last unification removed
implementation drift; temporal drift is a different animal. The product resolves a series' floating model to
`M@3` and stamps that digest; `latest` moves; submit re-resolves to `M@4` and seals it — nothing errors, and
the record then states in its own two fields that it answered a question it did not answer. The auto-eval
therefore presents `expectedContractDigest`, and submit re-seals and REFUSES on a mismatch before it creates
or dispatches anything. A mismatch costs a retry; the alternative costs evidence that misstates itself. Batches stamp it at submit (`origin.seriesContractDigest`, resolved through the same seam readiness
compares against, so the two can never drift into different answers); a newest batch whose stamp differs — or
is absent, meaning it cannot say which question it answered — is `contract_stale` and blocks a required
series. An unresolvable contract is its own verdict — `contract_unverifiable`, which BLOCKS a required series.
Returning "no answer" and letting the check skip was the unknown→absence→safe collapse this codebase has
removed three times elsewhere, sitting in the one place that decides whether a release ships: a deleted
dataset or a registry outage made stale evidence pass, in the direction of green. `unknown` (a deployment
with no resolver at all) stays a genuinely different fact and abstains.

And the resolution carries its PLAN, not just its digest. The auto-eval stamped a digest of `harness@10` and
then submitted the version-less ref, which `latest` had meanwhile moved to `@11` — a record whose origin and
whose execution named different versions. Using the same resolver twice is not the same as carrying one
decision; state moves between the calls. The ship path freezes the resolution once and reuses it for the
readiness evaluation AND the recorded decision (`seriesDecisions[].evaluationContract`), so what a release
passed is answerable without walking to a scorecard that may since have been deleted.

**Runtime is NOT part of the evaluation contract — a decision, not an oversight** (arch-review 14 §14). The
contract seals what is being ASKED: dataset, harness closure, judge closure. `autoEval.runtime` is placement,
and placement is not the question. The alternative — folding the execution world into the contract — is
tempting because a Windows run and a Linux run genuinely can produce different results, and it is wrong for
the same reason a too-broad guard is always wrong: every environment difference would become a contract
change, so every infrastructure move would invalidate a product's entire evidence base and the signal would
be trained out of people within a week.

The right decomposition is the one the scorecard side already uses:

```
Evaluation Contract   what is being asked   → identity; a change means new evidence is required
Execution World       where it ran          → cohort/stratum; a change means compare within, not across
```

So a world difference is a COMPARISON constraint, not an identity change: two runs of the same contract in
different worlds are the same question answered under different conditions, and the honest handling is to
stratify rather than to declare them incomparable. That machinery does not exist yet — everdict has no world
cohort axis, which is a real gap (the adoption-metrics work names it, and arch-review 15 §17 re-confirmed both
the gap and this decomposition) — and the decision recorded here is that when it arrives it arrives as a
cohort, not as another field in the contract digest. **Built (arch-review 19 P2).** The material was already there and honest: every case's `ExecutionManifest`
records the world it actually ran in (os + how the os was resolved, driver, image, runtime) and is ABSENT
where no world existed. `worldCohortOf` derives a batch's cohort from those at settle — so it reports rather
than declares, a batch spread over two operating systems is `mixed` rather than a majority, and a batch where
nothing reported a world carries no cohort at all.

The consumer is the release comparison, and what it does is deliberately proportionate: a comparison whose two
sides ran in different cohorts carries `crossWorld` on the recorded series state and in its reasons. It does
NOT refuse. Refusing would make an infrastructure migration un-shippable until every baseline is re-run —
precisely the too-broad guard this decomposition exists to avoid — while saying it is what stops a regression
and a migration from being indistinguishable in the record afterwards. An unrecorded world is not a known
difference either: a legacy batch compares silently, or every comparison against history would carry the
warning and the signal would be trained out within a week. Writing it down
because leaving it ambiguous is how "same series contract, different world" quietly ends up averaged into one
regression series.

**Service identity is the STREAM, not the name.** `serviceStreamKey` (repository · source · host · tagPrefix)
is one exported domain decision with three consumers that used to read it differently: the product edit
applied it (repoint a service and its watermark cannot survive), the sync reconciler re-matched by NAME and
could restore repo-A's watermark onto repo-B, and the version ledger keyed by name so repo-B's `v1.0.0`
collided with repo-A's and vanished as "already known". The ledger's natural key now includes the stream
(mig 0155), with legacy rows ADOPTED on first write rather than re-imported — re-importing would announce
years of history as news, the exact storm the backfill rule exists to prevent.

**Backfill takes BOTH signals.** "Has this service ever been synced" is answered by the watermark OR a ledger
row, and backfill requires the absence of both. The watermark alone was fragile (a first sync whose watermark
write lost its CAS left the service permanently in backfill, silently swallowing every later release); the
ledger alone is wrong the other way (a repository with no releases yet syncs successfully and imports
nothing). Wrong in the safe direction: announcing something arguably historical is a reader's judgement,
swallowing a release is unrecoverable.

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

**Version reads are paginated, with a declared ceiling.** `listReleases`/`listTags` sent one `per_page` and
stopped, so a repository with more than a page of history had its first page imported and the rest silently
absent — while the first sync is documented as backfilling "the timeline's past". Both now walk until a short
page, bounded by `maxPages` (default 50 × 100 = 5,000 versions). The bound is declared rather than incidental:
a limit that merely happens reads as completeness to whoever comes next.

**Deleting a product is ONE statement, and children SERIALIZE against it.** `removeAggregate` deletes all
three in a single data-modifying CTE — but atomicity is not serialization: a child INSERT took no lock on the
parent, so a `createRelease` that read the product before the delete could still insert its orphan after it.
Mig 0156 makes the relationship a FOREIGN KEY on `(tenant, product_id)` with `ON DELETE CASCADE`, which is
the parent-row lock protocol (Postgres takes KEY SHARE on the parent for every child insert) obtained without
a transaction API the `SqlClient` port does not have — and it enforces the TENANT correlation structurally,
so no application code has to remember to check it. `NOT VALID`: deployments may already hold orphans created
by the very race being closed, and validating would fail the migration on data the constraint exists to
prevent more of.

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
  pass rate via `headlinePassRate` and the triggering `serviceVersion`) + the issues' lifecycle markers +
  the watched capabilities' version registrations.

  **The evaluation contract is on the axis too** (`capabilities[]`): a new version of a watched harness,
  dataset or judge changes what the next auto-run asks, which makes it an event on this product's timeline
  exactly like a service release. It is derived from the series the product declares TODAY (a capability it
  stopped watching is no longer its news), windowed like the version ledger, and each event carries the
  `seriesKeys` that watch it — a product with several series needs the marker to answer "whose contract
  moved". The instants come from the registries' `versionDates` read (per-version registration time, live
  versions only, owner-first incl. the `_shared` fallback), wired through the optional
  `capabilityVersions` seam in `ProductServiceDeps` — a deployment without it serves the honest empty array,
  and a dangling series ref answers an empty map rather than failing the read.

  **An issue reaches the axis three ways, and only two of them are declared by a person.** `product` and
  `release` are explicit links; `evidence` is an issue that one of this product's own watch-series scorecards
  is cited by (`links[].type: "scorecard"`) or was **closed with** (`resolution.scorecardId` — which never
  becomes a link, so a link-only read misses the strongest relationship there is). Reading the explicit links
  alone drew an empty issue lane on exactly the products with the most to say: a workspace files against a
  regression, links the batch that shows it, closes with the batch that proves the fix, and never touches the
  product record. The extra cost is ONE query (`IssueListFilter.scorecards`, both halves in one statement)
  over the scorecards the trend already collected, so the window that bounds the trend bounds this too. Each
  row carries `via` — "we filed this against 2026.3" and "this cites a batch of ours" are different claims,
  and a lane drawing them identically asserts the stronger one.
  The default window is **the last 90 days through the product's HORIZON** — `to` reaches the furthest
  *planned* release's `targetDate` (end of that day), not the present instant, because a release is planned
  before it ships and an axis stopping at `now` cannot place the one marker the planning conversation is about
  (every future target collapsed onto the right edge at the same position). A cancelled release never stretches
  it — that is a date nobody is working toward. `from` stays a quarter measured back from `now` (or from a
  caller-named `to`), never from the horizon, or a release planned two months out would silently drop two
  months of the past the trend is read against. The window therefore also carries **`now`**: it is the boundary
  between the part of the axis that happened and the part that is intended, and what an open-ended span (an
  unresolved issue) ends at. The web draws the future half as a pressed-back band with a "today" line
  (`widgets/product-timeline`); it does not compute the boundary from the browser clock (SSR would disagree).
- `POST /products/:id/series/run` (MCP `run_product_series`) — Sync's counterpart: that refreshes the VERSION
  axis, this one the QUALITY axis. `keys` absent = everything the product currently watches; an empty array is
  refused rather than read as absent, because "run these, and there are none" is a caller's bug and reading it
  as "run everything" turns it into a batch storm.
- HTTP + MCP full parity in the `api/product` slice; authz reuses the ISSUE pair (`issues:read`/`issues:write`
  — the timeline is the same planning workflow, one axis over); delete = creator-or-admin in the service;
  product deletion cascades releases + ledger (they exist only under their product).
- Web: `/products` (+`/products/new`, a four-step WIZARD: basics → services (read a repository, tick the
  proposals, live prefix preview) → series → review+sync), `/product/[slug]` (services + subpaths + sync
  state, release strip with each release's composition, one `LineChart` per series — points click through to
  their scorecard, each series header carrying its own "evaluate now" and an empty one saying what would fill
  it, so a declared-but-unrun series is never a dead chart — the version ledger, history),
  `/product/[slug]/edit` (the flat form, for editing an
  existing declaration), `/release/[id]` (readiness card + gate UI: a 409 becomes an explicit forced-ship
  confirmation; plus the composition editor, versions picked from the ledger). `entities/product` carries the
  zod mirrors + drift guards and the ONE href builder (`productRef` picks slug-or-id); the tracker history
  renderer gained the `released` event.
- **The version ledger's axis is the SERVICE, not time.** A product assembles several services whose versions
  move on independent streams, and one table sorted by `publishedAt` answers no question anybody has: reading
  "where is api now" out of it means scrolling and filtering by eye. It is one card per tracked service
  (declared order, newest first, collapsed past six), with the streams the product no longer declares kept
  visible at the end rather than dropped — a renamed or repointed service's history disappearing silently
  reads as "the import broke".
- **A mark on the axis says what it is when you hover it** (`widgets/product-timeline`). Native `title` was
  what the marks had, and it is the wrong instrument for this screen: it waits a second, renders multi-line
  text differently in every browser, and is unavailable to the person trying to tell apart two dots 2px away
  from each other. Releases, version dots and both issue moments now draw a hover card in the same layer as
  the mark, and the series chart's tooltip takes a `renderPointDetail` slot (the triggering service version,
  the batch's status) plus a header spelled by `formatX` — it used to print the raw x value, so an ISO instant
  appeared verbatim in the one place a reader is asking a simple question.
- **An issue's lane draws two MOMENTS over a lifespan, not one bar.** Occurrence (◆ at `createdAt`) and
  resolution (● at `resolvedAt`) are what people look for on a timeline; a bar alone reads as "something was
  open in early August" and stops there. An unresolved issue gets no end marker — its span still stops at
  `now`, because a bar reaching into the future is a prediction rather than a fact.
  **Overlapping lifespans pack onto real tracks** (greedy interval assignment): the former odd/even-index
  split only separated neighbours, so three issues opened the same week drew the first and third exactly on
  top of each other. Track count = the actual maximum concurrency, and the lane grows its height for a dense
  window instead of hiding a span.
- **The detail page reads the same axis two more ways.** A day-grouped, newest-first EVENT FEED
  (`widgets/product-timeline` `timeline-feed.tsx`, the `detailed` prop — GitHub's project-timeline reading):
  every event the lanes draw — version published, release shipped / target day, issue opened/resolved (with
  the closing scorecard as an `evidence` link), series evaluated (pass rate + triggering version), capability
  version registered — told as sentences over the shared `ActivityFeed` atoms, capped with a show-more.
  Dates and day headers read in the SAME UTC the lanes' ticks use — a lane dot on 8/12 and a feed row saying
  8/13 would discredit both. And a WINDOW RANGE control (`?range=1m|3m|6m|1y` on `/product/[slug]`; the
  default quarter lives on no parameter, so the server keeps the one definition of "default"): a filter
  decides the set, so it rides the URL and a pasted link opens the same window. The home summary renders
  neither — lanes + trend only.

## Where the code lives

contracts `records/product.ts` + `wire/product/product.ts` · domain
`product/{product,release,readiness,discovery}.ts` · application-control
`product/{product-service,product-version-sync,series-evaluator,product-discovery}.ts` + `ports/product-store.ts` +
`ports/github-repo-writer.ts` (version reader + tree reader) · db `product/*` + mig `0138`/`0162`/`0169` ·
api `api/product/*` + `infrastructure/github/repo-writer.ts` · web `entities/product` +
`features/manage-product` (wizard + composition editor) + `widgets/product-timeline` + the routes.
