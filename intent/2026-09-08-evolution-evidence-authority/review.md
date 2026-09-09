# Review: evolution evidence authority

## Authority and effects

The evaluation effect is named by a server-minted scorecard id bound to a durable family
attempt before dispatch. Reservation failures and unknown storage outcomes stop submission.
An idempotent replay reads the original scorecard; it cannot dispatch a second copy.
Unreported attempts remain spent. Historical unbound rounds remain readable, but the
production logRound service has no path that accepts a newly unbound pair.

Family reservations, continuation creation and bound round append share the tenant
advisory lock. Reservation locks the campaign against close. Append seals its reported
marker in the same transaction as the round CAS and outbox, using the same lock order.
Closed campaigns retain attempts; a missing result is never treated as an unused test.

## Identity and claims

Policy documents 1.0.0 and 1.1.0 were compared with their pre-change source bodies and
remain unchanged. Legacy normalization also keeps its original observation-field omission
so old receipt digests are not rewritten; new structured scores retain those assessments.
Structured policy 2.0.0 keeps original score indices and canonical
digests in the basis. Producer/criterion ownership is consumed by verdict, deduplication,
rescore removal and judgment receipt attribution. Priority chooses a definition; multiple
producers matching that definition must agree. Legacy attribution retains the first failure.

Improvement, observed target satisfaction and non-inferiority are separate claims. A
required non-inferiority result must name the policy, cover every held-out case, meet
minimum sample counts and provide a qualifying lower bound. Missing evidence is
inconclusive, not a successful non-regression test. Partial execution evidence and
unmeasured/invalid score states keep their existing meanings.

## Capability bounds and sibling paths

Evidence grants contain immutable target-only views with no full scorecard/run references
or free-form learned text. HTTP enforces the capability at the server entry and at the
view reader. MCP registers only the capability reader and rechecks the grant on reads.
MCP POST, GET and DELETE also bind a session to the current authority, preventing a
scoped token from borrowing a workspace session. Workspace switching cannot promote it.
The sandbox flow seeds a platform-authored brief and a separate scoped credential file.

The scope is platform-issued campaign evidence authority. Independent workspace
credentials or external repository access are not revoked by a grant. Reservations whose
scorecard creation did not become readable remain spent and return a named conflict;
there is no speculative refund or redispatch. These limits are documented in the wiki.

## Test construction and verification

Settlement tests already supply completed scorecards through a diff fixture. Their
fixture now reserves each simulated execution pair before settlement and mints fresh
ids for repeated labels. A separate test drives the unwrapped service and proves that
an unreserved completed pair is refused. Real ScorecardService submission tests exercise
spend-before-dispatch, replay, changed request bytes and retry/rescore refusals.

Real PostgreSQL tests cover concurrent allocation, the last attempt, idempotent binding,
append/outbox CAS and unreported evaluation races across historically overallocated
siblings. In the latter, two siblings request 16 comparisons after 2 legacy rounds;
exactly 8 are admitted and the family remains at its limit of 10.

The non-inferiority counterexample was observed red before its gate was added (a round
without the declared assessment adopted). Protocol mutation rungs neutralize family
consumption, non-inferiority enforcement, MCP tool restriction and session ownership.
They were executed after the implementation commit so the mutation runner could restore
the exact committed source.

## Executed results

Implementation: `f6e3ba2b`. Verification completed on 2026-09-08.

- Full default suite: 8,464 passed and 438 skipped across 29 packages; all 51 Turbo tasks
  succeeded. Skipped infrastructure-dependent tests are not counted as executed coverage.
- Real PostgreSQL campaign trust suite: all 6 tests passed, including the shared-family
  reservation race, append/close competition and atomic outbox/reporting.
- Full build: 29 tasks passed. Typecheck: 51 tasks passed. Format, lint, docs-check,
  intent-chain, migrations (214 files) and whitespace checks passed.
- `protocol-mutations --only evolution-review`: all 4 selected mutations caused assertion
  failures, with no collection errors or compiler-only outcomes. Removing session ownership
  caused 1 failed assertion; removing family consumption caused 2; removing non-inferiority
  enforcement caused 1; removing scoped MCP tool registration caused 1. This is the selected
  4-rung subset of the 317-rung catalog, not a claim that the whole catalog ran.
- The mutation runner restored all source files to the implementation commit; the worktree
  was clean before this verification record was added.

The initial non-inferiority test and the historical observation-digest regression were both
observed failing against the preceding behavior, then passed with their respective fixes.
Migration 0214 is included for deployment; no production migration, push or deployment was
performed.
