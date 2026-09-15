---
kind: wiki
title: "Workspace knowledge — entries, time-axis pins, and task-context assembly"
status: current
updated: 2026-09-16
anchors: [packages/contracts/src/records/knowledge-entry.ts, packages/contracts/src/knowledge/node-ref.ts, packages/domain/src/knowledge/freshness.ts, packages/application-control/src/knowledge/knowledge-service.ts, apps/api/src/api/knowledge/knowledge.routes.ts]
---
# Workspace knowledge — entries, time-axis pins, and task-context assembly

> What exists: **knowledge entries** — reified claims a member or an agent writes ABOUT the workspace's entities —
> and the **skills** that share their pin model; a subject-time kernel that says whether a claim still reaches the
> present and where it sits relative to a task's coordinate; **task-context assembly**, which hands an agent the
> entries and skills about the entities its task concerns; and **thread extraction**, which proposes entries from a
> discussion for review. The entry library is `/[workspace]/knowledge` in the web.

A workspace keeps learning things its records cannot say on their own: "harness `web-agent@2.x` is flaky on login
cases when run on k8s", "we excluded case-7 because its reference answer is wrong", "judges on this dataset run
strict". Knowledge entries are where those go, and task-context assembly is how an agent inherits them before it
re-derives — and contradicts — last month's conclusion.

## Knowledge entries

A **`KnowledgeEntryRecord`** ([knowledge-entry.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/knowledge-entry.ts),
migrations `0084` + `0087`) carries:

- `kind` — `finding` | `decision` | `convention` | `context`, a thin classifier for rendering and filtering. Typed
  per-kind claim schemas are deliberately not modelled: the specificity lives in the text.
- `title` — the one-line claim; `body` — markdown, stored on the workspace filesystem as `knowledge/<id>.md` (see
  [workspace-filesystem.md](workspace-filesystem.md)) with the database row as the replica.
- `refs: KnowledgePin[]` — what the claim concerns, pinned on the time axis (below); `evidence: NodeRef[]` — the
  observations backing it (a scorecard, a run, a comment thread, an agent session). At most 16 of each.
- `status` — `proposed` | `active` | `superseded` | `deprecated`, plus `supersedes` (the entry this one revises). A
  revision never deletes the old claim; the new entry names it, and the old entry's status is a separate, gated write.
- `visibility` — `private` (a creator-only draft, the default) | `workspace` (read by every member and the agent;
  managed by its creator or an admin).
- `extraction` — present on extraction-born entries, and kept after approval as the claim's origin trail.
- `verifiedAt` — the last confirmation that the claim still holds, distinct from `updatedAt`.

Creating, proposing and approving an entry emit `knowledge.created`, `knowledge.proposed` and `knowledge.approved`
(`packages/contracts/src/records/platform-event.ts`).

A **Skill** ([skill.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/skill.ts)) is the
task-oriented complement — "how do I do this" against an entry's "what is true / why we decided". Its `refs` are the
same `KnowledgePin[]`, and the skill listing and `use_skill` surface its coverage.

## The reference vocabulary

A reference is a **`NodeRef`** — `{type, key, version?}`
([node-ref.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/node-ref.ts)) —
the generalisation of the `AgentReference` a user turn already carries. `key` is the entity's natural key within
its `(tenant, type)`: a registry id, a record UUID, a repository `owner/name`, a user subject, or a composite such as
`${datasetId}#${caseId}`. `version` is present only for immutable-versioned entities, and it is part of what the
reference names.

`type` is one of the 30 `NODE_TYPES`
([node-type.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/node-type.ts)):

| Axis | Types |
| --- | --- |
| **Actors** | `workspace`, `user` |
| **Intent** | `issue`, `project`, `initiative` |
| **Under test (versioned)** | `harness`, `dataset`, `case`, `judge`, `rubric`, `model`, `agent`, `capability` |
| **Execution infra** | `runtime`, `runner`, `image` |
| **Execution & outcomes** | `run`, `scorecard`, `schedule` |
| **Analysis** | `tag`, `metric`, `view` |
| **Knowledge & comms** | `skill`, `knowledge`, `comment`, `agent_session` |
| **Integration & external** | `repository`, `trace_source`, `secret`, `browser_profile` |

An extraction-born entry names the surface it came out of with one of the 23 `SOURCE_KINDS`
([source-kind.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/source-kind.ts)),
beside `sourceId`: the `(sourceKind, sourceId)` audit tuple. The two vocabularies overlap without being equal — a
comment is both, `pr_comment` is only a source, `metric` is only a type.

**Both vocabularies are closed and only grow.** Stored entries and skills parse `refs`, `evidence` and
`extraction.sourceKind` against them on every read, so removing a value makes each row naming it unreadable. Adding
one is a code change reviewed like any other.

## The time axis — intervals, not decay

Knowledge has COORDINATES: a **space axis** (which entity family a claim concerns — `(type, key)`) and a **time axis**
(which point of that entity's timeline — a *version*; assertion time is the wall-clock `createdAt`/`verifiedAt`).
**Time is a coordinate, not decay**: a claim pinned at `web-agent@2.1.0` stays true ABOUT 2.1.0 forever — the open
question is whether its validity *extends* to a given coordinate, and that is itself a recorded fact.

The pin is therefore an INTERVAL: **`KnowledgePin = NodeRef + { verifiedVersion? }`** — the known-valid interval
`[version, verifiedVersion]`. `version` is the point the knowledge was observed at (immutable); `verify` EXTENDS
`verifiedVersion` to each pinned family's current latest and stamps `verifiedAt`, leaving `updatedAt` untouched.
Client edits author plain `NodeRef`s; `verifiedVersion` is system-owned and carried over server-side when the
`(type, key, version)` triple is unchanged. Closing an interval needs no field: a superseding entry **pinned at the
version where the behavior changed** closes the old claim's interval.

Both vocabularies of the kernel live in
[freshness.ts](https://github.com/everdict/everdict/blob/main/packages/domain/src/knowledge/freshness.ts) and are
deliberately NOT merged:

- **Coverage** (record vs the entity's PRESENT, for listings and badges): `current | behind | unverified` —
  `assessCoverage` compares each pin's interval end against the family's latest, which
  `registryLatestVersionResolver` (`application-control`) reads from the registries. `behind` means "as-of an earlier
  point; validity at the present unknown" — never "wrong". A `behind` item has THREE legitimate outcomes: verify
  (extend), supersede (close, pinned at the change point), or leave as history. After 30 days without an edit or a
  verification a record with no gap falls to `unverified`.
- **Anchor relation** (record vs an ANCHOR coordinate, for context assembly): `covers | earlier | later | general` —
  `anchorRelation` positions the interval against a projection coordinate (below).

## Task-context assembly — as-of projection

`KnowledgeService.assembleContext`
([knowledge-service.ts](https://github.com/everdict/everdict/blob/main/packages/application-control/src/knowledge/knowledge-service.ts))
serves Everdict's own agent and developers' Claude Code sessions through the plugin — MCP `get_task_context` and
`POST /knowledge/context`. It takes **anchors** (the `NodeRef`s a task concerns) and returns
`{ knowledge, skills }`. **The anchor's own version IS the as-of coordinate**: an unversioned anchor resolves to the
family's latest; a month-old scorecard's `harness@2.1.0` anchor projects the knowledge base onto that point, plus the
`later` trail of what happened next.

```
assembleContext(anchors: NodeRef[]) →                      anchor.version ?? latest = the projection coordinate
  knowledge:  entries family-matched to anchors,  each labeled relation ∈ covers|earlier|later|general
  skills:     skills  family-matched to anchors,  same labels; listing-level only (no instructions body)
```

- **Records, not a projection.** Entries and skills are read straight from their stores, so a claim written a minute
  ago is in the next context.
- **Family match.** An item matches when one of its pins names an anchor's `(type, key)`, whatever the versions.
- **Ranking.** Entries rank **relation > status > recency**: at a past coordinate, a SUPERSEDED claim that `covers`
  it outranks an `active` claim from the coordinate's future. Skills rank by relation.
- **What is left out.** `proposed` entries (unreviewed), and private items that are not the caller's own.
- **Decoration.** Each item carries its present-coverage state when the latest-version resolver is composed. At most
  20 entries and 20 skills are returned.

The in-product agent calls it itself (`apps/agent/src/system-prompt.ts` directs it to open entity-anchored tasks with
`get_task_context`), and a turn carrying `@`-references asks it once for those references (`apps/agent/src/chat.ts`).

## The accumulation loop

Two paths fill the layer:

- **Authored** — `create_knowledge_entry` / `update_skill` via MCP and the in-product agent, whose system prompt
  directs it to record durable conclusions as entries and maintain coverage in-band (`verify_skill` /
  `verify_knowledge_entry`, or a superseding revision).
- **Extraction** — for comment threads: `POST /knowledge/extract` / MCP `extract_knowledge` (`comments:write`, a
  registered-model call) runs `KnowledgeExtractionService` (`apps/api/src/core/knowledge/`), which mines a thread for
  durable conclusions and stores up to five as `proposed` entries (workspace-visible, `extraction` provenance =
  `(sourceKind, sourceId)` + extractor + confidence; the discussed resource is added to `refs`, the thread root is the
  `evidence`; a re-run skips a title already extracted from the same thread). Review is the HITL promotion:
  `approve_knowledge_entry` flips proposed → active AND transfers authorship to the approver (the `extraction` field
  survives); `reject_knowledge_entry` deletes the candidate. Extraction is on-demand only.

## HTTP + MCP

`apps/api/src/api/knowledge/`. Every route 404s when its service is not composed, and each MCP family registers
only when its service is (extraction also needs the entry service).

| HTTP | MCP | Permission |
| --- | --- | --- |
| `POST /knowledge/context` | `get_task_context` | `scorecards:read` |
| `GET` / `POST /knowledge/entries`, `GET` / `PATCH` / `DELETE /knowledge/entries/:id`, `POST /knowledge/entries/:id/verify` · `/approve` · `/reject` | `list_` / `create_` / `get_` / `update_` / `delete_` / `verify_` / `approve_` / `reject_knowledge_entry` | reads `scorecards:read`; writes `comments:write` (edit/delete/verify additionally creator-or-admin) |
| `POST /knowledge/extract` | `extract_knowledge` | `comments:write` |

## Where the code lives

| Concern | Package |
| --- | --- |
| `KnowledgeEntryRecord`, `NodeRef` / `KnowledgePin`, the closed vocabularies | `@everdict/contracts` (`src/records/knowledge-entry.ts`, `src/knowledge/`) |
| Coverage and anchor relation (pure) | `@everdict/domain` (`src/knowledge/freshness.ts`) |
| `KnowledgeEntryStore` port, `KnowledgeEntryService`, `KnowledgeService`, the latest-version resolver | `@everdict/application-control` (`src/knowledge/`, `src/ports/`) |
| `InMemoryKnowledgeEntryStore` / `PgKnowledgeEntryStore`, migrations | `@everdict/db` |
| HTTP + MCP surface, thread extraction | `apps/api` (`src/api/knowledge/`, `src/core/knowledge/`) |
| The entry library | `apps/web` (`/[workspace]/knowledge`, `features/manage-knowledge`, `features/extract-knowledge`) |

## What is not built

- **A coverage-gap agenda** — coverage is computed per listing and per context request; nothing collects the gaps.
- **Retrieval beyond anchors** — no embedding or text search; a task with no anchors gets no context.
- **Extraction from agent sessions or pull-request comments** — both are source kinds; only comment threads have an
  extractor.

## Removed: the workspace knowledge graph

Until 2026-09-16 this page described a **knowledge graph**: a projection of the workspace's records into nodes and
typed edges (a mention/edge spine, harvesters, a pull `reindex`, multi-hop reads, authored `annotate` / `relate`, and
a map under Settings › Knowledge). It was removed as meaningless in the shape it was built, to be redesigned later;
knowledge entries were kept because they are the planned development system of record's storage for decisions,
lessons and conventions ([development-system-of-record.md](development-system-of-record.md)). Migration `0216` drops
its three tables, and its preflight records what was lost —
[0216-drop-knowledge-graph.md](../migration/preflight/0216-drop-knowledge-graph.md).

## References

- User-facing guide: [guide/workspace/agent-context.md](../guide/workspace/agent-context.md).
