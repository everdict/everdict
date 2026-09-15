---
kind: runbook
title: "Preflight — 0215 remove the team-era facts"
status: current
updated: 2026-09-15
anchors: [packages/db/migrations/0215_remove_team_era_facts.sql, packages/contracts/src/records/platform-event.ts, packages/contracts/src/records/tracker.ts]
---
# Preflight — `0215_remove_team_era_facts`

`0212` removed the team axis and kept its recorded facts. `0215` deletes them:

- platform events of kind `harness.moved`, `dataset.moved`, `judge.moved` and `scorecard.moved`, and the dead
  letters that point at one of them;
- tracker history entries `moved`, `member_added` and `member_removed` in issues, projects, initiatives,
  products and releases. Every other entry stays, in its original order.

Irreversible. The same change removes those words from `PLATFORM_EVENT_KINDS` and `TRACKER_HISTORY_EVENTS`,
and both vocabularies are parsed on read, so the code in this change cannot read a row that still holds one.
The API applies pending migrations at boot before it builds a store, so a replica on the new code never reads
the old rows. A replica still on the old code reads the cleaned rows without trouble, because it never
required those words to be there.

## OK_TO_APPLY when both hold

1. **`0212` is applied**, meaning `everdict_teams` no longer exists:
   ```sql
   SELECT to_regclass('everdict_teams');   -- must be NULL
   ```
2. **Nobody still needs the team history.** Count what will be deleted and read the number before applying:
   ```sql
   SELECT kind, count(*) FROM everdict_platform_events
    WHERE kind IN ('harness.moved','dataset.moved','judge.moved','scorecard.moved') GROUP BY kind;
   SELECT count(*) FROM everdict_issues
    WHERE history @> '[{"event":"moved"}]' OR history @> '[{"event":"member_added"}]'
       OR history @> '[{"event":"member_removed"}]';
   ```
   The platform event log is swept on its own schedule, so the events are usually already gone. The issue
   history is the only durable record of which team an issue came from. If that answer is still needed, export
   those entries first.

## ALREADY_APPLIED

`everdict_schema_migrations` holds `0215_remove_team_era_facts.sql`. Running the file again changes nothing:
both `DELETE`s match zero rows, and every `UPDATE` is filtered to histories that still contain one of the
three words.

## BLOCKED

`everdict_teams` still exists, or condition 2 has not been read and accepted.

## Verified against a real engine

Run on a throwaway Postgres 16 by the real `migrate()`: all migrations up to `0214`, then a seed, then `0215`.

- **Before `0215`, the new vocabulary could not read the seed.** A history of
  `created, moved, updated, member_added, status_changed, member_removed, completed` failed
  `TrackerHistoryEntrySchema`, and the `*.moved` event kinds were not in `PLATFORM_EVENT_KINDS`.
- **After `0215`**, the history was `created, updated, status_changed, completed` (order kept) and parsed. A
  history holding only team entries became `[]`. Clean and empty histories were left unchanged. The four
  `*.moved` events and the dead letter pointing at one were gone. `harness.registered` and its dead letter
  were still there.
- **A second `migrate()` applied nothing**, and running the raw file again changed nothing.
