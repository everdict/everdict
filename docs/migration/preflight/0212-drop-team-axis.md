---
kind: wiki
title: "Preflight — 0212 drop the team axis"
status: current
updated: 2026-09-03
---
# Preflight — `0212_drop_team_axis`

`0212` is the CONTRACT half of removing the team concept. It drops fourteen `team_id` columns, the
`team_ids` list on projects, the cycle table and column, and `everdict_teams` / `everdict_team_members`.
All of it is irreversible.

## OK_TO_APPLY when all three hold

1. **`0211` is applied** and every workspace has a non-null `issue_key`:
   ```sql
   SELECT id FROM everdict_workspaces WHERE issue_key IS NULL;   -- must return nothing
   ```
2. **Every issue carries its workspace's prefix** — i.e. `scripts/live/migrate-teams-to-workspace.mjs` has run:
   ```sql
   SELECT i.tenant, count(*) FROM everdict_issues i
     JOIN everdict_workspaces w ON w.id = i.tenant
    WHERE i.identifier NOT LIKE w.issue_key || '-%'
    GROUP BY i.tenant;                                            -- must return nothing
   ```
3. **The exposure is accepted.** The script prints how many previously team-private rows become visible to the
   whole workspace. That number is the decision this migration makes on somebody's behalf, so it is read and
   accepted before applying — not discovered afterwards.

## ALREADY_APPLIED

`everdict_teams` does not exist. The script says so and exits 0.

## BLOCKED

Any of the three queries above returning rows. Run the script (or finish it — it is idempotent and resumable
per workspace) before applying.

## What is deliberately NOT preserved

- **Old identifiers stop resolving.** `ENG-12` is not an address any more; the issue's `former_identifiers`
  records what it used to be called, and nothing serves a redirect. This was the maintainer's choice over
  freezing old prefixes — stated here because a link in a pull request is where it will be noticed.
- **Cycles and triage are gone**, not migrated. "Cycle 7" existed once per team, so collapsing them into one
  sequence would renumber windows that retrospectives cite by number.
- **Team privacy is gone.** See condition 3.

## Verified against a real engine

The whole path was driven on a throwaway Postgres 16 — 216 migrations to the pre-`0211` state, teams and
issues seeded, `0211`, the script, `0212` — rather than reasoned about:

- **216 → `0211` → script → `0212`** applies clean; `everdict_teams` / `everdict_cycles` /
  `everdict_team_members` are gone and **zero** `team_id` / `team_ids` / `cycle_id` / `in_triage` columns
  remain anywhere.
- **The privacy count is printed before any write**, and a `--dry-run` changes nothing.
- **Re-running is a no-op** ("already migrated"), so an interrupted run is safe to repeat.
- **The allocator agrees with the backfill**: after re-issuing three issues the next `allocateForIssue`
  returns `ACME-4`, and 50 parallel allocations take 50 distinct numbers.
- **The partial unique index does its job**: two issues cannot share an identifier in one workspace, and the
  same name in another workspace is accepted.

⚠️ **One P0 was found this way and fixed here.** The first version renamed issues in one pass, which walks into
names its own siblings still hold: a workspace `acme` whose team key was already `ACME` derives the prefix
`ACME`, so `OPS-1` (older) is assigned `ACME-1` while the row holding `ACME-1` has not moved yet. Postgres
refused on the `0211` unique index, the transaction rolled back, and the operator could not migrate at all —
on what a single-team workspace named after its team looks like. The re-issue is TWO passes now (park every
moving row under `reissue~<n>`, a name no key can mint, then assign), both inside the same transaction. Driven
red on that seed before the fix and green after.

⚠️ **And the script could not be started at all.** It imported `@everdict/contracts` by package name; `scripts/`
is not a workspace package, so pnpm links no `node_modules/@everdict/*` and node threw `ERR_MODULE_NOT_FOUND`
— on the operator's machine, on the one run that matters. It imports the relative `dist` paths every other
script in that directory uses.
