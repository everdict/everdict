# Dismissed scan findings

A finding is dismissed here, with a reason, or it is not dismissed. Written by
`pnpm scan --dismiss --scope <s> --file <path> --reason "<why>"`, and **committed**: `.git/` does not travel
with a clone, and a dismissal nobody else can read is a dismissal the next person redoes.

The pressure this record exists to apply is the one the article names — *every dismissal has a reason, so the
same finding does not return as new on the next run* — and the reason being committed is the only thing that
makes it real. A dismissal ledger without reasons turns the findings-per-scan trend into a number anybody can
lower by clicking.

A dismissal is not a fix. `pnpm scan` marks a dismissed finding as previously dismissed rather than hiding it,
so a scope that has been dismissed into silence still reads as a scope full of dismissals.

<!-- entries below, newest last -->

- `2026-09-05` · **api** · `apps/api/src/api/harness/harness.routes.ts` — parsing before authorizing is deliberate here and consistent with its siblings at lines 39 and 104; the scanner's 'unlike every other door' claim was not verified and is contradicted by the same file
