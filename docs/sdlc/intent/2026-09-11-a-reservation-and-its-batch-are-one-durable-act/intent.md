# Intent: a reservation and the batch it reserves are one durable act, or the gap is a state nobody owns

Author: Claude (closing the carried questions of `intent/2026-09-10-diverged-comparisons-and-uncertified-scenarios/`). Status: draft

Design: none yet — the alternatives below are the design question, and the honest one costs a transaction seam
neither store has. `pnpm design --next` will pick this up when it is accepted.

## Problem

`CampaignService.spendOf` classifies each reserved arm by reading its scorecard row. A row that is not there
reads `lost`, and `lost` is what lets a campaign END.

The reservation is written BEFORE the scorecard row, deliberately: `ScorecardService.submit` calls
`campaigns.reserveEvaluation(...)` and then `store.create(record, facts)`, so a replay meets an existing
reservation and refuses rather than dispatching a second batch. Two stores, two commits, and between them the
spend reader answers `lost` about an arm that is about to exist.

Nothing here is a clock bug or a missing guard. It is the shape rule `protocol` names three times over:

> **a decision and the effect it authorizes must be one durable act, or the gap between them is a state
> nobody owns.**

`armStateOf`'s own comment has carried this since it was written, and it states the bound honestly: only a
campaign whose budget is otherwise fully spent can be ENDED by it, and `settle` re-reads the ledger, so the
window has to still be open at the close for anything to be lost. That is a narrow race with a real cost —
a campaign ends one round early and the arm that would have decided it is thrown away.

It is also L5 pointed the wrong way: *"cannot find out" is an escalation field, never a terminal state.*
Absent-because-in-flight and absent-because-dead are the same read, and the code resolves them to the
terminal one.

## Proposed outcome

A reserved arm never reads `lost` because of a window this system opened. Stated as the property rather than
the mechanism, because the mechanism is the design question:

- **Either** the reservation and the batch row commit together, so the absent state is unreachable;
- **or** an absent row is a third answer that can CONVERGE — a debt with an owner, not a terminal — and a
  campaign that cannot find out does not end on that arm.

Whichever is chosen, a genuinely dead reservation must still be able to retire, or this reopens the deadlock
R2 closed: a campaign that can neither reserve again nor settle.

## Affected users and systems

`packages/application-control` (`ScorecardService.submit`, `CampaignService.spendOf`/`armStateOf`),
`packages/application-control/src/ports` (whichever port grows the seam), `packages/db`
(`PgScorecardStore.create` is a single data-modifying CTE today, and `reserveInFamily` reads family records
and attempts before it writes — it cannot become a CTE), and the in-memory twins, which must make the same
decision or every unit test proves the wrong branch (rule `testing`).

## Constraints

- **The reservation may not move after the batch.** It is before it so a replay cannot dispatch twice; the
  R2 record and `submit`'s replay arm both depend on that order.
- **A dead reservation must still retire.** `unknown` that never converges is the R2 deadlock with a nicer
  name.
- **No clock.** Deciding that an absent row has been absent "long enough" is the re-derivation this
  repository refuses everywhere else, and it would be a decision about the submitter's liveness read off the
  reader's wall clock.
- **The twins decide alike.** A guard that lives in a Postgres transaction is a guard no unit test can see
  (rule `testing`); if the repair is transactional, its counterexample is a `*.trust.test.ts`.

## Open questions

These ARE the design pass, not leftovers from it.

- **Does `SqlClient` expose a transaction the two stores can share?** Both tables live in one database, so a
  cross-store act is possible in principle; what does not exist is a seam that carries it. The `settleWith`
  rider is the precedent this repository already has for "one more effect rides this transaction", and the
  question is whether a reservation — which READS a family and enforces a budget before writing — can ride
  one at all, or whether the reservation has to move INTO the store that owns the transaction.
- **Or is the convergent third answer cheaper and truer?** An absent row becomes `unknown`/outstanding, plus
  an owner that can observe the submission is never coming and retire the reservation. That is L5's shape —
  a debt owning its worklist — and it costs a reconciler rather than a transaction seam. It also needs a
  durable fact saying the submitting request is gone, and this intent does not know what that fact is.
- **What does an operator do today?** A campaign wedged by a dead reservation has no documented door. If the
  convergent answer is chosen, that door is part of it.
