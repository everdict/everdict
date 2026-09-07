# Intent: deleting a workspace leaves sixty tables of its data behind

Author: pnpm scan (scope `adapters`, sonnet) — verified by hand before filing. Status: shipped

Shipped: d7077903

Design: none — two named defects in one adapter, both with the source read and the failing input reproduced
against a real Postgres.

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

## The other finding from the same scan, kept so it does not stay in `.git/`

`PgCapabilityStore.register` (`packages/db/src/workspace/capability-store.ts:175`) does a plain
SELECT-then-INSERT/UPDATE with no `ON CONFLICT` guard, although `(tenant, id, version)` is the table's primary
key. Two concurrent registrations of the same brand-new version both see "absent" and both insert; one gets a
constraint violation that surfaces as a raw database error rather than as this repository's own refusal.

**Low confidence, and recorded as such** — it is the scanner's own rating, it was not reproduced, and the
window is narrow. It is written here rather than left in `.git/everdict-scan-adapters.json` because that file
does not travel with a clone, and a finding nobody else can read is a finding that has to be found again.

## Open questions

- Is `delete()` reachable from an API door, or only from an operator path? The blast radius differs, and it
  was not traced.
- Do any of the sixty carry cascade rules that already remove them? Some may be covered by
  `ON DELETE CASCADE` from a parent that IS in the list; that was not checked table by table, and the count
  above is of tables not named, not of tables provably orphaned.

## Shipped

**The sweep was not merely incomplete — the delete THREW** (`25494f14`). The intent said the delete "reports
success and leaves that tenant's data in the database". It does not report success. `everdict_connections`
was dropped in `0046_drop_connections.sql` and stayed in the list THIRD FROM THE TOP, so on any database
migrated past 0046 the third statement raises `relation "everdict_connections" does not exist` and the whole
call rejects. `DELETE /workspace` — reachable from the web's settings page and from an MCP tool, which answers
the first open question — returns 500, the workspace row is never removed, and the two tables above the dead
entry have already lost their rows. Verified against a real Postgres migrated to head (219 migrations): the
workspace, its members and an agent row all survived a delete that threw.

That is worth stating plainly, because it changes who was hurt. Nobody has quietly lost data believing it was
deleted; everybody who tried to delete a workspace was told the operation failed, and it had.

**The set is derived now.** `everdict_%` base tables in the current schema carrying a `workspace` or `tenant`
column, ordered so a referenced table is swept after the ones pointing at it. A table added tomorrow is swept
without anybody remembering that file exists, and a table dropped yesterday cannot break the delete. An empty
derived set REFUSES rather than removing the workspace row: an enumeration that answered nothing is not a
workspace with no data (rule `protocol` L5).

**The second finding was real** (`d7077903`). `PgCapabilityStore.register`'s SELECT-then-INSERT let two
concurrent registrations of one new version both insert; the loser's unique violation escaped as a raw driver
error, so an idempotent re-register became a 500 and a genuine content conflict arrived as a driver error
rather than this store's 409. `ON CONFLICT … DO NOTHING RETURNING 1` moves the decision to the statement the
engine arbitrates, and the losing arm re-reads through the same code the pre-read used.

## The open questions, answered

- **Is `delete()` reachable from an API door?** Yes — `DELETE /workspace` (`workspace.routes.ts`), which
  `apps/web`'s delete-workspace feature calls, plus the MCP tool beside it. Not an operator-only path.
- **Do any of the sixty carry cascade rules that already remove them?** Effectively none. All 219 migrations
  contain FIVE `REFERENCES` clauses in total, four of them `ON DELETE CASCADE`, pointing at
  `everdict_trajectories` and `everdict_products` — both themselves tenant-scoped and swept directly. The
  count of unswept tables was 55 by this reading (the intent said 60; the difference is live-versus-created
  tables and columns added by `ALTER`), and cascades cover none of them.

## Note — what the census cost, and what it bought

Nothing here needed a model to find. It needed the migrations parsed against the list, which is thirty lines
of script, and it turned "the sweep has drifted" into "the sweep has been broken since migration 0046". The
scan named the right file and got the SEVERITY backwards — a reading is a starting point, and the arithmetic
is the part that decides what to build.

## Open question this change deliberately did not answer

`RETAINED_AFTER_DELETE` ships EMPTY. Whether billing rows (`everdict_usage`, `everdict_budget_usage`) or an
audit trail should outlive a workspace delete is a product decision nobody has made, and inventing one while
repairing a sweep would file it in the wrong place. Today they are swept, which is what the door promises.
There is also no refusal for deleting `_shared` — the seed owner every workspace resolves shared capabilities
through. Nothing makes that reachable and nothing forbids it; it is named here rather than guarded, because an
unreachable refusal is a claim about a window with nothing able to test it.
