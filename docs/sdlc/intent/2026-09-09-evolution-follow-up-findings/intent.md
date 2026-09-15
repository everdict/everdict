# Intent: close the four findings the 2026-09-09 evolution follow-up review left open

Author: maintainer (requested in conversation). Status: shipped
Shipped: c4c54eae
Design: none — `docs/architecture/evolution-review-2026-09-09.md` is the requirements document. Each finding
already carries its reproduction, the repair it requires in the reviewer's own words, and the closure test
that would settle it; a design pass over that would restate it.

⚠️ **This intent was filed AFTER its implementation, at the maintainer's request, and it carries no
`plan.md` for that reason.** A plan written now would be a description that agrees with itself — the exact
artifact `intent/README.md`'s ordering rule exists to refuse — and back-dating one would defeat the only
check that can tell the two apart. What the chain shows here is an intent with no plan, and a commit that
lands AFTER the work it describes, which is the honest shape: `intent-chain` checks intent-before-plan and
shipped-after-plan, and with no plan it asks neither, so the only thing that can say this ran out of order
is this paragraph and the commit graph agreeing with it. The predecessor is
`intent/2026-09-08-evolution-evidence-authority/`, whose implementation these findings are about.

## Problem

The 2026-09-08 change (`75851600`, `f6e3ba2b`) bound campaign evaluations to a durable attempt ledger and
tightened the evidence a round rests on. Its own follow-up review found four things that change did not
close — three of which are ways the settlement can be wrong or stuck, none of which any gate can see:

- **R1 (P1).** The oracle check — the boundary that stops a candidate from rewriting its own exam — resolved
  both commits it compares from the two scorecards' `origin`. Those coordinates are the submitter's: the door
  stamps `origin.source` server-side and copies `repo`/`sha` verbatim. So the check verified that two
  caller-authored strings agreed and echoed them into its receipt. Submit the baseline's origin with the
  candidate's own sha and the oracle compares a commit with itself, receives no changed paths, and certifies
  `clean` about a change it never looked at. A campaign could then adopt a candidate that had edited its own
  dataset, judge rubric or tests, with a receipt that reads exactly like a real one.
- **R2 (P1).** `budget.maxRounds` is spent by RESERVATIONS and the adoption gate counted ROUNDS. A comparison
  reserved and never reported is spent in the first number and invisible in the second, so a campaign whose
  attempt was lost could neither reserve again ("evaluation budget is exhausted") nor settle ("the gate
  answers continue"). It costs the driver the whole campaign, and the two numbers that disagree are both
  called "the budget".
- **R3 (P1).** `logRound` came to require an unreported reservation owning both scorecard ids, and every
  shipped first-party evolve procedure still told the agent to execute first and log afterwards.
  `agent_evolve` is the sharpest case: it uploads through `ingest_scorecard`, which had no reservation field
  at all, so a supported procedure could not produce an acceptable pair through any sequence of the doors it
  was given. The `harness_evolve` procedure also recommended reusing one baseline batch across rounds, which
  the ledger refuses, and `code_evolve` still composed its own delegation brief.
- **R4 (P2).** The collector parsed a score's display metric for its criterion instead of reading the shape
  the producer was constructed with, trying the namespaced prefix and falling back to the bare one. For a
  producer whose id is `judge` — the inline judge's default — those two readings answer the same question, so
  the criteria `x` and `judge:x` landed on ONE measurement identity. Structured deduplication keys on exactly
  those coordinates, so two distinct criteria combined into one decider and a criterion-specific policy clause
  covered a criterion nobody named.

Who it costs: anyone running an evolution campaign. R1 costs the defensibility of an adoption; R2 costs the
campaign; R3 means the product's own agent cannot drive the loop the record was built for; R4 quietly
conflates measurements the analyst believes are separate.

## Proposed outcome

- The oracle compares commits the PLATFORM authored, on both sides, or says `unverifiable` and names which
  side is missing. Caller origin fields stay on the round as provenance and decide nothing.
- A campaign that can no longer buy a comparison can close, and one whose reserved comparison can still
  finish and win is not closed. Lost attempts stay spent — nothing refunds budget.
- Every shipped evolve procedure can be driven from reservation through submission or ingestion to round
  logging, using only the doors it preloads, and says so on both arms.
- Two criteria that differ only by a `judge:` in their id stay two measurements.

Each is settled by the closure test the review names, observed red under a neutralization of its own repair.

## Affected users and systems

`packages/contracts` (the score identity and the oracle receipt), `packages/domain` (the adoption gate and
the new campaign-spend owner), `packages/application-control` (the campaign service, the ingest lane, the
first-party procedures), `packages/db` (the campaign store and the reservation door), `packages/graders` and
`packages/application-execution` (the two collection boundaries), `apps/api` (the ingest doors). Skill
`evolve` and its two references, plus `docs/architecture/code-evolution-loop.md`, carry the same contract for
a human or outside driver and move with it.

## Constraints

- **The conservative half of the 2026-09-08 change stays.** A spent reservation is spent whether or not its
  batch landed; nothing here refunds budget or speculatively re-dispatches.
- **No caller-authored value may become an authority.** The repairs may only move decisions onto values the
  platform writes; a validator on a producer's string is not a repair.
- **Stored rows must keep decoding.** Anything added to a record schema is optional at rest, and its absence
  means what it meant before rather than being backfilled.
- **A refusal has to be usable.** Where a repair makes a previously-working configuration unverifiable, the
  message names what would supply the missing provenance, and the first-party procedures say how to get it.
- Only the reported findings. The merge effect also reads a round's `candidateSource`, and binding THAT to
  verified provenance is a separate question this change does not open.
- **The two gates this branch was already failing get repaired, not inherited.** `pnpm import-cycles` and
  `pnpm web-reach` were red at HEAD before any of this work — verified by stashing it — and leaving them red
  would teach the next person to read past a gate. Neither repair may widen an allowlist to do it: the cycle
  is untangled the way that check's own header prescribes, and the two web routes are DECIDED with reasons
  read out of the code rather than assumed.

## Open questions

Carried, and recorded in the review document's own limits section rather than resolved here:

- **A reserved comparison reads as lost while its submission is in flight.** The reservation is written before
  the scorecard row so a replay cannot dispatch twice; between those two commits the spend reader answers
  "lost" about an arm that is about to exist. The honest close is one durable act across the two stores.
- **`builtSourceFor` resolves a version by taking the newest `built` record that minted it.** That predates
  this change; what changed is that the oracle now decides on it, and two records minting one version would
  be resolved by clock — the re-derivation rule `protocol` L3 names.
- **An `environment` subject with a non-empty `oracleScope` now answers `unverifiable`**, because the build
  ledger is keyed by harness instance version. No first-party procedure opens that combination, and nothing
  yet decides whether it should be supported or refused at open.
- **`decision` and `settle` now read one scorecard per bound arm of every unreported attempt.** Bounded by
  `budget.maxRounds` and deduplicated, but it is a linear read where there was none — and this branch is
  named for a read budget.
- **`attemptsForCampaign`'s statement has not been planned by a real engine.** `trust-fast` needs a Postgres
  this session did not have.
