# Intent: deleting a workspace leaves sixty tables of its data behind

Author: pnpm scan (scope `adapters`, sonnet) — verified by hand before filing. Status: draft

## Problem

`PgWorkspaceStore.delete()` (`packages/db/src/workspace/workspace-store.ts:228`) removes a workspace by
looping over `WORKSPACE_SCOPED_TABLES` — a hand-maintained list of **18** `[table, column]` pairs — and then
deleting the workspace row itself.

The migrations create **91** tables. Counted against the list, **60 of them carry a `workspace` or `tenant`
column and are not in it**: agents, agent sessions, agent messages, agent tasks, approvals, comments, budget
limits and usage, capabilities, browser profiles, environments, created worlds, execution attempts, fs
revisions, handoff checkpoints, the whole eval tracker (initiatives, issues, labels, updates), evolution
campaigns and their build sets, rounds and evidence, adoption operations, cycles, envelopes, analysis
artifacts, intermediate cleanup records, constitution approvals — and more.

The list predates most of the schema. Every feature added since has added tenant-scoped tables, and none of
them added a line here, because nothing asks. Deleting a workspace therefore removes the workspace row and
leaves that tenant's data in the database: the delete reports success, the workspace disappears from every
read, and the rows remain.

This is the shape `pnpm option-forwarding` exists for one layer up — a rebuild that is an allowlist, silently
eating whatever was added after it was written. That check reads the field names off the interface so the list
cannot drift. Here the interface is the schema, and the list drifted for sixty tables.

## Proposed outcome

A workspace delete removes every tenant-scoped row, and the set is derived rather than maintained: the schema
already knows which tables carry a `workspace` or `tenant` column, and a list that has to be remembered is a
list that will drift again. A table that must NOT be swept says so, once, with its reason.

## Affected users and systems

`packages/db/src/workspace/workspace-store.ts`, every tenant-scoped table, and anyone who has deleted a
workspace believing its data went with it.

## Constraints

- **Deriving the set is the fix; extending the list is not.** Adding sixty lines today leaves the same defect
  for the sixty-first table, and the next person to add a feature has no reason to know this file exists.
- Some tables may be deliberately retained — billing records, an audit trail. Those become a declared
  exception with a reason, the way every other allowlist in this tree works, rather than an omission.
- Order matters where foreign keys do. A derived sweep needs to respect them or run inside a transaction that
  defers them.
- Found by a scan whose answer was **discarded** by its own runner for not being valid JSON. That is fixed in
  the same change as this filing, because a reading nobody can count is still a reading.

## Open questions

- Is `delete()` reachable from an API door, or only from an operator path? The blast radius differs, and it
  was not traced.
- Do any of the sixty carry cascade rules that already remove them? Some may be covered by
  `ON DELETE CASCADE` from a parent that IS in the list; that was not checked table by table, and the count
  above is of tables not named, not of tables provably orphaned.
