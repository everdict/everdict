# Intent: a comparison that names two commits is not one that covers them, and a suite that skips is not one that passed

Author: maintainer (requested in conversation). Status: shipped
Shipped: 4573eba0
Also shipped in: `dd5c154b` — the trust-scenario half, which landed FIRST. `Shipped:` takes one sha (the
check's own grammar), and one sha is a poor audit trail for an intent holding two defects: a reader opening
4573eba0 to check whether the six red certifications were repaired finds only the oracle comparison. Both are
named here rather than splitting the record, because the two halves were found by the same act — running
`trust-fast` because a review document declared it as a limit — and separating them would hide that.
Design: none — `docs/architecture/evolution-review-2026-09-10.md` is the requirements document for the first
half. It carries the reproduction against live public GitHub, the two repairs the reviewer would accept in
their own words, and the regression it asks for; a design pass over that would restate it. The second half is
not a design question at all — six certifications were red and the repair is to make each assert what
production emits.

⚠️ **This intent was filed AFTER its implementation and carries no `plan.md`, for the same reason its
predecessor did not** — see `intent/2026-09-09-evolution-follow-up-findings/`, whose repairs this one is
about. A plan written now would be a description that agrees with itself, and back-dating one would defeat the
only check that can tell the two apart. `pnpm intent-chain` checks intent-before-plan and shipped-after-plan;
with no plan it asks neither, so the only thing that can say this ran out of order is this paragraph and the
commit graph agreeing with it. ⚠️ It was also filed because `pnpm review` ASKED for it, on the batch that
would otherwise have shipped without one — which is worth recording, because the previous intent was filed for
the same reason and the lesson evidently did not transfer.

## Problem

Two things, found the same afternoon by two different mechanisms, neither of which is a gate in this repository.

### The oracle's comparison answers a different question from the one it is asked

`intent/2026-09-09-evolution-follow-up-findings/` closed R1 by making the oracle's commits come from
Everdict's own build ledger, and a follow-up review then closed the attestation that check rests on: the
production composition had been spreading its own request into its own reply, so "does the listing describe
the two commits we evaluated" compared a value with itself. The repair read the attestation from GitHub's
comparison response instead.

That repair was right and it leaned on a sentence nobody opened the endpoint to check. `/compare/A...B` is
**three-dot**: its `files` describe merge-base→B, not A→B. On a diverged history those are different answers,
and the endpoint still echoes A and B faithfully — so the attestation is genuine, nothing is forged, and a
protected file the BASELINE changed after the fork is simply absent from the list.

Reproduced by an outside review against live public GitHub (`octocat/Hello-World`, `b1b3f972…...b3cbd5bb…`,
status `diverged`): the production oracle returned a **clean** receipt over a README whose blob genuinely
differs between the two evaluated commits.

Who it costs: any campaign whose candidate branch was cut before its baseline was built — which is most of
them. The oracle is the boundary that stops a candidate rewriting its own exam, and a clean receipt is what an
adoption rests on.

### Six trust scenarios had been red since the identity change, and every local gate was green

The measurement-identity work in the previous intent made `sanitizeScore` stamp a structured `measurement` on
every score at the collection boundary. Five trust scenarios assert a whole `Score` with `toEqual` and went
red on the fourth key. A sixth digests a raw literal into a commit receipt and lets `Run.succeed` sanitize
what it stores, so the receipt named bytes the row would never hold — which
`case-outcome-committer.ts`'s own comment describes as the thing that happens, about a fixture that was doing
it.

Every one of those files gates on `EVERDICT_TRUST_SUITE=1`. `pnpm test` skips them, `pnpm ci:local` boots no
database by design, `pnpm ci:commits` skipped them once per commit — and `trust-fast`, the required check that
owns them, is a GitHub workflow, and every workflow here has been `disabled_manually` since 2026-08-21
(declared-limits C3). So a change shipped with six certifications red and nothing anywhere could say so.

Who it costs: everyone reading a green push as evidence about the scenarios that were never run.

## Proposed outcome

- A listing whose comparison did not START at the evaluated baseline leaves the round `unverifiable`, with a
  reason naming the operator's repair. A listing that names no starting point is refused for its own reason —
  not saying is a third answer, not a permission.
- Every trust scenario in the fast subset runs and holds against real infrastructure, and each one ASSERTS the
  stamped identity rather than tolerating it.
- What the local gates cannot see about the trust suite is written down where the next person meets it.

## Affected users and systems

`apps/api` (the GitHub comparison adapter and the oracle composition), `packages/application-control` (the
repo-writer port, `GithubAppService`, and `CampaignService.oracleCheck`), `packages/db` and
`packages/application-execution` and `apps/api/src/trust` (the fixtures and counterexamples).
`docs/architecture/evolution-review-2026-09-10.md` is the review record; `docs/architecture/evolution-review-2026-09-09.md`
loses "real PostgreSQL: not executed"; `lessons/2026-09-10-five-certifications-went-red-and-pnpm-test-said-green.md`
holds the second half.

## Constraints

- **No forgery is involved and the repair may not pretend otherwise.** The requested and returned SHAs are
  genuine; what is missing is coverage, so the refusal is about the comparison's starting point and not about
  trust in the caller.
- **A fixture is repaired to the shape production emits, never loosened to accept both.** A scenario that lets
  the identity float has stopped certifying the thing that makes a metric name safe to carry.
- **The cost of the refusal is stated, not softened.** It fires on ordinary diverged pull requests, and that is
  the fail-closed direction.

## Open questions

Carried, and recorded where a reader meets them rather than resolved here:

- ~~**The real two-tree difference is not computed.**~~ **CLOSED 2026-09-11.** It still is not — the compare
  API is three-dot only and a hand-rolled trees diff is a second implementation the oracle would have to
  trust — but the question it was blocking is answered by one more call to the SAME endpoint:
  `files(M...B)` beside `files(M...C)` makes the union a superset of the two-tree difference, so a scope that
  misses the union is genuinely clean. The refusal on ordinary diverged pull requests is gone, the live probe
  now answers `touched: ["README"]` instead of declining, and the receipt records which question was answered
  (`pathsCover`). What stays open is narrower: the 300-file cap is per comparison and either side reaching it
  makes the listing incomplete, and that arithmetic is pinned only against constructed responses.
- ~~**Nothing counts the scenarios a push did NOT certify.**~~ **CLOSED 2026-09-11** — `pnpm trust-certified`,
  wired into `ci:local`: the scenario count in the required check's scope, the last certification's sha and
  date, and which files in that scope have changed since. ⚠️ It is the FALLBACK and shipping it records that
  C3 stays; the repair is still `gh workflow enable`, which is the maintainer's to run.
- **The adapter's reading of a comparison response is pinned against constructed bodies**, plus one live probe
  of the diverged case. `base_commit`, `merge_base_commit`, `status` and `commits` are read from the documented
  shape, and no authenticated or GitHub Enterprise response has been seen.

Two questions this batch inherited from `intent/2026-09-09-evolution-follow-up-findings/` and settled on
2026-09-11:

- **`builtSourceFor` resolved a version by whichever record the ledger returned first** — a clock wearing an
  index, and the ORACLE had come to decide on it. Records that AGREE are one answer written twice (a rebuild)
  and are admitted; records that DISAGREE about the source refuse the round, because nothing here may choose
  between them and falling through would hand `verdictOf` the submitter's own coordinates, which is what R1
  closed.
- **The in-flight reservation window is FILED, not fixed** —
  `intent/2026-09-11-a-reservation-and-its-batch-are-one-durable-act/`. It needs a transaction seam neither
  store has, or a convergent third answer with an owner; choosing between those is a design pass, and doing
  it at speed beside four other changes is how this session's six red certifications were written in the
  first place.
