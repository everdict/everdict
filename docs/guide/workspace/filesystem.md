---
kind: wiki
title: "The workspace filesystem"
status: current
updated: 2026-08-11
---
# The workspace filesystem

Every workspace gets one isolated file tree. Agents write their task output into it, members open the
same files in the web app, and skills and knowledge live in it as their source of truth.

Write a file:

```bash
curl -XPUT localhost:8787/fs/file \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "path": "reports/august-regression.md",
  "content": "# August regression\n\nscorecard sc_91f2 lost 4 cases on the retrieval suite.\n",
  "message": "first pass from the weekly review"
}'
```

Read it back:

```bash
curl 'localhost:8787/fs/file?path=reports/august-regression.md' -H 'x-everdict-tenant: default'
```

List a directory:

```bash
curl 'localhost:8787/fs/entries?path=reports' -H 'x-everdict-tenant: default'
```

That is the whole basic surface: `PUT /fs/file`, `GET /fs/file`, `GET /fs/entries`,
`POST /fs/directories`, `POST /fs/entry` (move), and `POST /fs/executions` (run a file).

## Every write is an attributed revision

The interesting part is what happens on the way in. A write does not overwrite bytes — it **publishes a
revision**, and the revision records *who* published it. That "who" is a member **or an agent**: the
agent's id, the conversation it was acting in, and the member it was acting for.

So a file's history answers "the numbers in this report changed — who changed them?" even when the
answer is "the weekly-review agent, in conversation `cv_881`, acting for jimin".

## Two writers, one file

Pass `baseRevision` when you are editing something you read earlier:

```bash
curl -XPUT localhost:8787/fs/file \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "path": "reports/august-regression.md",
  "content": "# August regression\n\n…my edit…\n",
  "baseRevision": 3,
  "message": "add the flakiness note"
}'
```

If someone — or some agent — published revision 4 while you were editing, this returns **409** rather
than winning the race. The 409 body carries the live content *and* a three-way merge, so the client can
show both sides instead of asking you to retype your work.

Omit `baseRevision` and you get last-write-wins. That is fine for a file only you touch, and wrong for
anything an agent also writes.

:::tip
Agents in a conversation write under `tasks/<conversation-id>/`, so one agent's scratch output never
lands on another's. You can browse it in the web app under **Files**.
:::

## Run a file

A file in the tree can be executed as a run, which is how a saved script becomes a repeatable job:

```bash
curl -XPOST localhost:8787/fs/executions \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "path": "scripts/summarize.py",
  "image": "python:3.12-slim",
  "timeoutSec": 300
}'
```

The result is a normal [Run](../concepts/run.md) — same record, same trace, same place in the activity
feed.

## Where the bytes actually are

One **S3/MinIO bucket per tenant**, named per workspace and created lazily. The bucket *is* the
isolation boundary — not a prefix inside a shared bucket — so a path-traversal bug in one workspace
cannot reach another's data. The adapter rejects traversal paths as well, but the bucket is what makes
the guarantee structural rather than careful.

Revisions go to a sibling bucket, so history survives a file being replaced or deleted.

:::warning
The `dev` compose profile keeps this in memory and loses it on restart. Use the `full` profile
(`bash deploy/compose/full.sh`) when you want the filesystem to persist — it brings up MinIO.
:::

## What lives here besides your files

- **Skills** — `skills/<id>/SKILL.md`
- **Knowledge** — `knowledge/<id>.md`
- **Agent task output** — `tasks/<conversation-id>/`

For skills and knowledge the filesystem is the source of truth: a save writes the file first, and a
read prefers the file, re-syncing the database replica lazily behind it. Editing `SKILL.md` in the
tree *is* editing the skill.

## See also

- [Workspace agents](agents.md) — the other writer in this tree
- [`../../architecture/workspace-filesystem.md`](../../architecture/workspace-filesystem.md) — the design record
