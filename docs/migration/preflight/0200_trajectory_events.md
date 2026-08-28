# Preflight — 0200_trajectory_events

**Change:** additive (expand). Creates `everdict_trajectory_events` (one row per trace event/span, PK
`(run_id, emitter, seq)`, `ON DELETE CASCADE` from the header) and adds `body_split boolean NOT NULL DEFAULT
false` + `batch jsonb` to `everdict_trajectories` and `everdict_trajectory_segments`. No column is dropped,
narrowed, or made NOT NULL. Ships with the deploy.

**Preflight:** `preflight(client, "0200_trajectory_events.sql")`
- `OK_TO_APPLY` — not yet in `everdict_schema_migrations`; every statement is `IF NOT EXISTS`.
- `ALREADY_APPLIED` — recorded; the migrator skips it.
- `BLOCKED` — n/a (nothing destructive).

## The rolling-deploy window, stated rather than discovered

`body` stays `NOT NULL`, deliberately. A plane sealed by the NEW code writes its events into
`everdict_trajectory_events`, sets `body_split = true`, and leaves `body` as an empty array.

So during a rollout, a replica still running the PREVIOUS release reads `body` and finds `[]`:

| replica | reads | sees |
|---|---|---|
| new | `body_split` → the events table | the trajectory |
| old | `body` | an empty trajectory |

That is a visible, temporary degradation of a READ, and it is the reason the column was not relaxed to
nullable: a NULL would have crashed the old replica's `EventsSchema.parse` instead. **No bytes are at risk** —
the events live in the new table throughout, and the old replica writes nothing that the new one cannot read.

Consequence for operators: finish the rollout before treating trajectories sealed during it as readable
everywhere. Nothing needs re-sealing afterwards.

## Legacy planes are not migrated by this file

Rows written before this migration keep `body_split = false` and are read whole. Above
`MAX_LEGACY_BODY_BYTES` the store answers `too_large` rather than materializing them — the honest answer,
because serving a window of a blob costs the whole blob, and the alternative is the OOM this whole change
exists to remove.

`scripts/live/split-trajectory-bodies.mjs` converges them: it reads one plane at a time, refuses any body
over its own `--max-bytes` ceiling, writes the event rows and flips `body_split`, and **names the planes it
could not split** rather than reporting a clean run. A plane it skipped keeps answering `too_large`, which is
true.

**Post-migration invariant** (pinned by `packages/db/src/results/trajectory-store.test.ts` and the paged
projection counterexample in `packages/domain/src/trace/paged-projection.counterexample.test.ts`): a plane
paged at any page size yields exactly the events the whole plane yields — including the relative `t` axis and
the `llm_call` count, which is what `batch` exists to preserve.

**Rollback (contract, if ever needed):** `DROP TABLE everdict_trajectory_events;` plus dropping `body_split`
and `batch` — only after no code reads them, and only after the split planes have been folded back into
`body`, which nothing does today. Not a step to take casually: for a split plane, `body` is `[]` and the
events table is the evidence.
