---
kind: wiki
title: "Workspace Knowledge Graph"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/knowledge/node-type.ts, packages/contracts/src/knowledge/predicate.ts, packages/contracts/src/records/knowledge-entry.ts, apps/api/src/api/knowledge/knowledge.routes.ts, packages/application-control/src/knowledge/knowledge-service.ts]
---
# Workspace Knowledge Graph

> What exists: the contract spine (`packages/contracts/src/knowledge/`); the `KnowledgeStore` port with in-memory and
> Postgres implementations; a multi-hop query engine; pure structured harvesters in `@everdict/domain`; a
> pull-based `reindex`; the `knowledge/` HTTP + MCP slice (graph reads, authored notes and relations, knowledge
> entries, task-context assembly, thread extraction); and two web screens — the map (Settings › Knowledge) and the
> entry library (`/[workspace]/knowledge`). The graph is centred on the **intent stratum** (§The intent stratum): the
> issue is the hub, and execution records are evidence admitted by reference, not inventory. The entity stratum
> changes only when someone runs a reindex (§What is not built).

Everdict's data is a web of relationships that is otherwise only *implicit* — a scorecard's config names a harness,
dataset, judges and a runtime; a comment discusses a resource; a spec references secrets by name. The **workspace
knowledge graph** makes that web *explicit and queryable*: one type-agnostic layer of **nodes** (the domain
entities) and **edges** (their relationships) that any surface — a resource panel, the agent, an impact query —
reads through one multi-hop engine.

This is a deliberate **reinterpretation of the `travel_knowledge` knowledge system in `workspaces/digo-data`**, not a
copy. That system extracts a travel graph from unstructured UGC through a type-agnostic `mention` / `edge_mention`
spine. We keep its design locks and adapt the one axis that differs: everdict's entities are already structured and
already own canonical identity, so the graph is *harvested deterministically* rather than *extracted from text*.

## The reinterpretation at a glance

| digo-data `travel_knowledge` | everdict knowledge graph |
| --- | --- |
| `stg_post` — normalized UGC post (the source document) | **source** — an everdict artifact that carries references, named by `(sourceKind, sourceId)`; not copied, just cited |
| `mention` — an LLM-extracted *surface* reference, resolved later | **`Mention`** — one observed reference to a node. A **deterministic harvest** of a structured record field (`origin: "harvest"`, `confidence` 1.0, born resolved) or an **authored** note (`origin: "authored"`) |
| `edge_mention` — a `(subject, predicate, object)` triple | **`EdgeMention`** — same, with the same two reference styles (by mention id XOR by node id) |
| per-type entity mart — the canonical entity | **`KnowledgeNode`** — a lightweight canonical *projection* of an existing record (one type-agnostic table, since everdict entities already have identity) |

## The three layers

```
  everdict domain records
  (issues, schedules, registry specs, skills, knowledge entries, referenced runs/scorecards …)
        │
        │  HARVEST (structured fields, deterministic)   +   AUTHORED (annotate / relate)
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  MENTION SPINE  (type-agnostic, append-only, auditable)      │
  │    Mention       — node_type + node_ref + node_attrs         │
  │    EdgeMention   — predicate + subject + object + polarity   │
  └─────────────────────────────────────────────────────────────┘
        │  harvesters also upsert the source's own node row
        ▼
  KnowledgeNode  (canonical projection)   ── multi-hop query engine ──▶  HTTP / MCP / web map
```

### Layer 0 — Sources

A **source** is the everdict artifact a reference was observed *in*. Everdict does **not** materialize a normalized
copy — the source already exists as a domain record, so a mention just carries the `(sourceKind, sourceId)`
provenance tuple. That tuple is the **audit lock**: every mention and edge is traceable back to what produced it.

`SOURCE_KINDS` ([source-kind.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/source-kind.ts))
has 23 kinds in three families, and `MentionOrigin` (`harvest` | `extraction` | `authored`) records how a reference
was drawn out:

- **Structured** (`scorecard`, `run`, `schedule`, `issue`, `project`, `initiative`, `*_spec`, `view`, `membership`,
  `workspace_settings`, `skill`, `knowledge_entry`) → **harvested**: a deterministic projection of record fields.
  Confidence is `1.0`; the mention is born `resolved`; the evidence is the field path (`evidencePath`, e.g.
  `origin.scheduleId`).
- **Text** (`comment`, `agent_message`, `pr_comment`) → the `extraction` origin: `nodeRef` is a surface form,
  `confidence` < 1, and the evidence is a text excerpt (`evidenceQuote` + offsets). No extractor writes mention-spine
  rows today; the one text-extraction path produces proposed knowledge entries instead (§The accumulation loop).
- **`authored`** — a user or agent deliberately asserting a note or a relation through the API / MCP.

The `SourceKind` vocabulary overlaps but is **not** identical to `NodeType`: a scorecard is both a node and a source;
`workspace_settings` and `pr_comment` are sources but not nodes; `tag`/`metric`/`image` are nodes but never sources.

### Layer 1 — The mention spine

Two type-agnostic tables (migration `0076`), mirroring digo-data.

**`Mention`** ([mention.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/mention.ts)) — one observed reference to a node:

- `nodeType` + `nodeRef` + `nodeAttrs` (jsonb) — *type-agnostic*: one shape carries every node type; type-specific
  hints go in `nodeAttrs`, never per-type columns.
- `sourceKind` + `sourceId` — provenance.
- `origin` + `extractor` + `confidence` — how it was drawn out.
- `evidencePath` (harvest) / `evidenceQuote` + offsets (extraction, authored) — the **audit lock**, enforced in the
  schema.
- `resolution` (`resolved` | `pending` | `unresolved`) + `resolvedNodeId` — surface → canonical.

**`EdgeMention`** ([edge-mention.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/edge-mention.ts)) — one observed
relationship:

- `predicate` + `subject*` + `object*` + `edgeAttrs` (jsonb) + `polarity` (`affirmed` | `negated` | `mixed`).
- **Two reference styles**, exactly one per side (XOR, enforced): `*MentionId` or `*NodeId` — digo's `idx` XOR
  `canonical_id`. Self-edges are refused.
- Same provenance, origin, confidence, evidence and resolution fields as `Mention`.

Invariants inherited from digo-data:

1. **Type-agnostic wire** — never a per-node-type mention table or a per-predicate edge table. Vocabulary is the
   extension axis.
2. **Append-only + auditable** — a mention/edge is never mutated; a re-harvest with a newer `extractor` appends a new
   row. Deterministic ids (`mentionId` / `edgeId` in `@everdict/domain`) make harvest idempotent.
3. **Surface-then-resolve** — `nodeRef` is what the source said; canonicalization is recorded in `resolution`.
4. **Polarity survives** — a `negated` edge is a first-class field, never dropped.

### Layer 2 — Nodes

**`KnowledgeNode`** ([knowledge-node.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/knowledge-node.ts)) is the canonical
projection of a domain entity — digo's per-type entity mart, collapsed into **one** type-agnostic table. It is a
*derived read-model*: each harvester upserts its source's own node row by `nodeId` (`HarvestBuilder.self`), and a
reindex may delete execution nodes (§The intent stratum). It never duplicates a record's body — only a display
`label` and a small `attrs` bag so a render draws the node without re-fetching. Referenced object nodes are not
materialised by the referencing harvester; an edge points at the derived id, and the node row exists only once that
entity's own harvester has run.

- **Node identity** is version-pinned and readable: `nodeId(tenant, ref)` in `@everdict/domain` yields
  `<type>:<tenant>:<key>[@<version>]` (e.g. `harness:acme:web-agent@1.0.0`). Harness `web@1.0.0` and `web@2.0.0` are
  **distinct nodes**; a `succeeds` edge joins them only when the version's recorded origin names its own family —
  version adjacency is never inferred.
- **`NodeRef`** (`{type, key, version?}`) is the structural handle — the generalization of
  [`AgentReference`](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/agent-session.ts) (`{type,id,version,label}`), which
  user turns carry in `AgentMessageRecord.references[]`. No harvester reads those references today.

## Node vocabulary (closed, PR-gated)

`NODE_TYPES` ([node-type.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/node-type.ts)) — 30 types by axis. The vocabulary
is **closed**: inventing a type is a code change, never a runtime value. Because the spine is type-agnostic, adding
one is a one-line enum extension plus a harvester.

| Axis | Node types |
| --- | --- |
| **Actors (WHO)** | `workspace`, `user` |
| **Intent (WHY — the hub)** | `issue`, `project`, `initiative` |
| **Under test (versioned)** | `harness`, `dataset`, `case`, `judge`, `rubric`, `model`, `agent`, `capability` |
| **Execution infra (WHERE)** | `runtime`, `runner`, `image` |
| **Execution & outcomes (WHEN)** | `run`, `scorecard`, `schedule` |
| **Analysis** | `tag`, `metric`, `view` |
| **Knowledge & comms** | `skill`, `knowledge`, `comment`, `agent_session` |
| **Integration & external** | `repository`, `trace_source`, `secret`, `browser_profile` |

Deliberately **not** nodes: `member` (an edge, `member_of`), `notification` / `budget` / `usage` (projections /
metering), `workspace_settings` (a source).

## Predicate vocabulary (closed, PR-gated)

`PREDICATES` ([predicate.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/predicate.ts)) — 41 predicates by axis. **Direction
is fixed**: an edge points FROM the dependent/referencing node TO the referenced node. The typical
`subject → object` shapes are conventions the harvesters follow, not wire enforcement.

| Axis | Predicates (typical subject → object) |
| --- | --- |
| **Provenance** | `created_by` (any → user), `member_of` (user → workspace, role in `edgeAttrs`), `in_workspace` (any → workspace) |
| **Intent** | `verified_by` (issue → harness/dataset/judge/scorecard/run/view — an issue link; note in `edgeAttrs`), `resolved_by` (issue → scorecard — the closing evidence and regression baseline), `part_of` (issue → project; project → initiative; initiative → parent), `assigned_to` (issue → user; project/initiative lead with `edgeAttrs.role`), `born_from` (capability version → issue/project/scorecard/… — `CapabilityOrigin.from`) |
| **Eval composition** | `evaluates` (scorecard/run/schedule → harness), `uses_dataset`, `includes_case` (dataset → case), `covers_case` (run → case), `applies_judge`, `uses_rubric` (judge → rubric), `uses_model`, `runs_on` (→ runtime), `placed_on` (run → runner), `child_of` (run → scorecard; sub-issue → parent issue), `fired_by` (scorecard → schedule) |
| **Results & measurement** | `measures` (scorecard → metric; mean/passRate in `edgeAttrs`), `compared_to` (scorecard ↔ scorecard diff), `supersedes` (knowledge → knowledge; scorecard → scorecard) |
| **Lineage** | `succeeds` (entity@vN → its recorded predecessor), `forked_from` (entity@v → the OTHER id's version it was copied from, digest on the edge), `derived_from` (scorecard → the scorecard it retried; dataset → dataset) |
| **Agent & comms** | `adopts` (agent → capability), `references` (agent turn → any), `discusses` (comment → resource), `reply_to` (comment → comment), `mentions` (→ user) |
| **Knowledge** | `about` (skill/knowledge → any — what a claim/procedure concerns), `evidenced_by` (knowledge → scorecard/run/comment/agent_session — the evidence trail) |
| **Integration** | `triggers` (repository → harness), `connects_repo` (workspace → repository), `pins_image` (harness → image), `runs_image` (case/run → image), `exports_to` / `pulls_from` (harness/schedule → trace_source), `uses_secret` (any → secret), `uses_browser_profile` |
| **Classification** | `tagged_with` (any → tag) |

No harvester emits `includes_case`, `covers_case`, `compared_to`, `references`, `mentions`, `triggers`,
`connects_repo`, `pins_image`, `runs_image`, `exports_to` or `uses_browser_profile`; they exist in the vocabulary and
can be asserted through `relate`. `uses_secret` is emitted by the registry-spec harvesters, which makes "what
references this secret" a graph query.

## The intent stratum — the issue as hub

The graph is centred on the **intent stratum** — the eval tracker ([docs/tracker.md](../tracker.md)): the **issue is
the hub**, because it is the one record whose whole job is to gather the others ("what verifies this problem, what
closed it, why did it come back"). High-cardinality execution records would otherwise drown the strata a workspace
reads the map for.

1. **Intent (WHY)** — `issue` / `project` / `initiative`, harvested whole from the tracker stores
   ([harvest-tracker.ts](https://github.com/everdict/everdict/blob/main/packages/domain/src/knowledge/harvest-tracker.ts)):
   an issue's links become `verified_by` edges (version pin + note preserved), its resolution `resolved_by`, its plan
   coordinates `part_of` (project) + `child_of` (parent issue) + `assigned_to` (assignee; project/initiative leads
   carry `edgeAttrs.role: "lead"`).
2. **Capability (WHAT)** — the versioned eval subjects/config, plus **origin lineage**: a registered version's
   `CapabilityOrigin` (stored per version in the registries, exposed on list entries as `versionOrigins`) becomes
   `born_from` (why it exists), `succeeds` (same family) or `forked_from` (another id).
3. **Execution (EVIDENCE)** — run/scorecard records are materialised **only while something references them**: an
   issue link, an issue resolution, a knowledge entry's refs/evidence, a skill's refs, or a capability origin.
   Reindex collects those references first, harvests only the referenced execution records, and **prunes** execution
   nodes whose reference went away (per type, only when that type's source is wired). The append-only mention/edge
   spine is never touched, and a re-referenced record re-materialises idempotently on the next reindex. "Recent runs
   of this harness" is a `RunStore` question, not a graph question.

Not projected: issue `labelIds` (registry ids — a tag node labelled by a UUID says nothing; it needs label-name
resolution at harvest time).

## The knowledge layer — claims over predicates

The structural vocabulary answers *"what is wired to what"*. What it cannot express is a **claim about entities** —
"harness `web-agent@2.x` is flaky on login cases when run on k8s". Encoding claims as predicates would force the
closed vocabulary open; free-text notes (`annotate`) cannot carry revision, evidence or multi-entity anchoring.

The resolution is **reification**: a claim is a first-class `knowledge` node whose *content* carries the specifics,
and the graph records only what the claim concerns (`about`) and what backs it (`evidenced_by`). The structural
stratum keeps its specific 39-predicate grammar; the knowledge stratum uses two generic predicates over rich nodes:

```
knowledge:"login cases flaky on k8s"
   -[about]->        harness:web-agent@2.1.0
   -[about]->        runtime:k8s-prod
   -[evidenced_by]-> scorecard:abc123
   -[evidenced_by]-> comment:thread-42
```

### Knowledge entries

A **`KnowledgeEntryRecord`** ([knowledge-entry.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/knowledge-entry.ts), migrations
`0084` + `0087`) is the record behind a `knowledge` node — the promoted successor of an `annotate` note (which stays
as the lightweight margin note). It carries `kind` (`finding` | `decision` | `convention` | `context` — a thin
classifier), a one-line `title` (the node label), a markdown `body` (stored on the workspace filesystem as
`knowledge/<id>.md`, see [workspace-filesystem.md](workspace-filesystem.md)), `refs: KnowledgePin[]` (→ `about`
edges), `evidence: NodeRef[]` (→ `evidenced_by` edges), at most 16 of each, `status` (`proposed` | `active` |
`superseded` | `deprecated`) + `supersedes` (→ a `supersedes` edge), `visibility` (`private` | `workspace`), optional
`extraction` provenance, and `verifiedAt` (last confirmation that the claim still holds — distinct from
`updatedAt`). Only workspace-visible, non-`proposed` entries enter the graph.

Not modelled: per-kind structured claim schemas, argumentation predicates (`supports`/`contradicts`), embedding
search.

### The time axis — intervals, not decay

Knowledge has COORDINATES: a **space axis** (which entity family a claim concerns — `(type, key)`) and a **time axis**
(which point of that entity's timeline — a *version*; assertion time is the wall-clock `createdAt`/`verifiedAt`). The
version-pinned node id already IS that coordinate. **Time is a coordinate, not decay**: a claim pinned at
`web-agent@2.1.0` stays true ABOUT 2.1.0 forever — the open question is whether its validity *extends* to a given
coordinate, and that is itself a recorded fact.

The pin is therefore an INTERVAL: **`KnowledgePin = NodeRef + { verifiedVersion? }`**
([knowledge-node.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/knowledge-node.ts)) — the known-valid interval
`[version, verifiedVersion]`. `version` is the point the knowledge was observed at (immutable); `verify` EXTENDS
`verifiedVersion` to each pinned family's current latest and stamps `verifiedAt`, leaving `updatedAt` untouched.
Client edits author plain `NodeRef`s; `verifiedVersion` is system-owned and carried over server-side when the
`(type, key, version)` triple is unchanged. Closing an interval needs no field: a superseding entry **pinned at the
version where the behavior changed** closes the old claim's interval. The `about` edges carry the interval in
`edgeAttrs` (`{asOf, verifiedVersion}`).

Both vocabularies live in the pure kernel ([freshness.ts](https://github.com/everdict/everdict/blob/main/packages/domain/src/knowledge/freshness.ts)) and are
deliberately NOT merged:

- **Coverage** (record vs the entity's PRESENT, for listings/badges): `current | behind | unverified` —
  `assessCoverage` compares each pin's interval end against the family's latest, which
  `registryLatestVersionResolver` (`application-control`) reads from the registries. `behind` means "as-of an earlier
  point; validity at the present unknown" — never "wrong". A `behind` item has THREE legitimate outcomes: verify
  (extend), supersede (close, pinned at the change point), or leave as history.
- **Anchor relation** (record vs an ANCHOR coordinate, for context assembly): `covers | earlier | later | general` —
  `anchorRelation` positions the interval against a projection coordinate (below).

Skills join the same model: a **Skill** ([skill.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/skill.ts)) is the
task-oriented complement ("how do I do this" vs an entry's "what is true / why we decided"), its `refs` are the same
`KnowledgePin[]`, and the skill listing and `use_skill` surface its coverage.

### Consumption converges on `assembleContext` — as-of projection

Context assembly serves everdict's own agent and developers' Claude Code sessions through the plugin — MCP
`get_task_context` / `POST /knowledge/context`, both over `KnowledgeService.assembleContext`. **The anchor's own
version IS the as-of coordinate**: an unversioned anchor resolves to the family's latest; a month-old scorecard's
`harness@2.1.0` anchor projects the knowledge base onto that point, plus the `later` trail of what happened next.

```
assembleContext(anchors: NodeRef[]) →                      anchor.version ?? latest = the projection coordinate
  1. structural facts:  relatedFacts(anchor) per anchor     (graph, 1 hop, ranked)
  2. knowledge:         entries family-matched to anchors,  each labeled relation ∈ covers|earlier|later|general
  3. skill candidates:  skills  family-matched to anchors,  same labels; listing-level only (no body)
```

Entries and skills are read from their RECORDS, not from the graph, so context never waits for a reindex; matching
is by `(type, key)` family. Entry ranking is **relation > status > recency**: at a past coordinate, a SUPERSEDED claim
that `covers` it outranks an `active` claim from the coordinate's future. Proposed entries are excluded. Each item
also carries its present-coverage state; at most 20 entries and 20 skills are returned.

### The accumulation loop

Three paths fill the layer:

- **Harvest** — a reindex projects registry specs, tracker records, schedules, skills and entries.
- **Authored** — `create_knowledge_entry` / `update_skill` via MCP and the in-product agent, whose system prompt
  (`apps/agent/src/system-prompt.ts`) directs it to open entity-anchored tasks with `get_task_context`, record durable
  conclusions as entries, and maintain coverage in-band (`verify_skill` / `verify_knowledge_entry`, or a superseding
  revision).
- **Extraction** — for comment threads: `POST /knowledge/extract` / MCP `extract_knowledge` (`comments:write`, a
  registered-model call) runs `KnowledgeExtractionService` (`apps/api/src/core/knowledge/`), which mines a thread for
  durable conclusions and stores up to five as `proposed` entries (workspace-visible, `extraction` provenance =
  `(sourceKind, sourceId)` + extractor + confidence; the discussed resource is added to `refs`, the thread root is the
  `evidence`; a re-run skips a title already extracted from the same thread). Review is the HITL promotion:
  `approve_knowledge_entry` flips proposed → active AND transfers authorship to the approver (the `extraction` field
  survives); `reject_knowledge_entry` deletes the candidate. Extraction is on-demand only.

## Where the code lives

| Concern | Package |
| --- | --- |
| Schemas (node/mention/edge, closed vocabularies, `KnowledgeEntryRecord`) | `@everdict/contracts` (`src/knowledge/`, `src/records/knowledge-entry.ts`) |
| Node/mention/edge id derivation, harvesters, coverage + anchor relation, predicate ranking | `@everdict/domain` (`src/knowledge/`, pure) |
| `KnowledgeStore` / `KnowledgeEntryStore` ports, `KnowledgeService`, `KnowledgeQueryService`, `KnowledgeEntryService` | `@everdict/application-control` (`src/knowledge/`, `src/ports/`) |
| `InMemoryKnowledgeStore` / `PgKnowledgeStore`, the entry stores, migrations | `@everdict/db` |
| HTTP + MCP surface, thread extraction | `apps/api` (`src/api/knowledge/`, `src/core/knowledge/`) |
| Rendering | `apps/web` (`features/knowledge-graph`, `features/manage-knowledge`, the infra panel's `knowledge` tab) |

## What exists

1. **Storage** — the `KnowledgeStore` port + `InMemoryKnowledgeStore` / `PgKnowledgeStore` (migration `0076`):
   append-only mention/edge tables (idempotent by id), an upsert-by-`nodeId` node table, and
   `listNodeIds`/`deleteNodes` for pruning. `DATABASE_URL` selects Postgres; without it the store is in-memory.
2. **Harvesters** — pure projectors built on the shared `HarvestBuilder`, each stamped with a versioned `extractor`:
   `scorecard` / `run` / `schedule`, `issue` / `project` / `initiative`, the registry-spec
   harvesters `harness` / `dataset` / `judge` / `runtime` / `model` / `rubric` / `agent` (which take a
   `SpecHarvestMeta` since a spec carries no tenant/timestamp; they also emit `uses_model` / `uses_rubric` /
   `uses_secret` / `adopts`, including cross-tenant `adopts` via `HarvestBuilder.ref`'s `objectTenant`), and
   `skill` / `knowledge_entry`.
3. **Reindex** — `KnowledgeService.reindex` (`POST /knowledge/reindex`, `settings:write`) pulls initiatives,
   projects, issues, schedules, each registry entity at its latest version (dataset/judge/runtime/model/rubric/
   harness/agent, with `versionOrigins`), workspace-visible skills and entries, and then only the referenced
   scorecards and runs; it returns `{scanned, nodes, edges, pruned}`. Nothing harvests comments, memberships or
   capability records, so comment and user nodes are never materialised.
4. **Authored write path** — `annotate` stores an `authored` mention resolved to its node (read back via
   `GET /knowledge/annotations` / `knowledge_notes`); `relate` stores an `authored` edge over the closed vocabulary,
   idempotent by (author, subject, predicate, object). The `authored` origin lets a query separate what the system
   DERIVED from what a person (or their agent) ASSERTED.
5. **Multi-hop query engine** — `KnowledgeQueryService`: `subgraph` (BFS by depth / direction / predicate / node type
   over the store's single-hop primitives, capped at 500 nodes) + `relatedFacts` (ranked 1-hop facts).
6. **HTTP + MCP** — `apps/api/src/api/knowledge/`:

   | HTTP | MCP | Permission |
   | --- | --- | --- |
   | `GET /knowledge/node` · `/related` · `/subgraph` · `/graph` · `/annotations` | `get_knowledge_node` · `knowledge_related` · `knowledge_subgraph` · `get_knowledge_graph` · `knowledge_notes` | `scorecards:read` |
   | `POST /knowledge/context` | `get_task_context` | `scorecards:read` |
   | `POST /knowledge/reindex` | `reindex_knowledge` | `settings:write` |
   | `POST /knowledge/annotate` · `/relate` | `annotate_knowledge` · `relate_knowledge` | `comments:write` |
   | `GET` / `POST /knowledge/entries`, `GET` / `PATCH` / `DELETE /knowledge/entries/:id`, `POST /knowledge/entries/:id/verify` · `/approve` · `/reject` | `list_` / `create_` / `get_` / `update_` / `delete_` / `verify_` / `approve_` / `reject_knowledge_entry` | reads `scorecards:read`; writes `comments:write` (edit/delete/verify additionally creator-or-admin) |
   | `POST /knowledge/extract` | `extract_knowledge` | `comments:write` |

   Every route 404s when its service is not composed. The in-product agent bridges these tools; the graph reads are
   classified read-only, the writes go through its permission gate.
7. **Rendering** — Settings › Knowledge (`apps/web/src/app/[workspace]/settings/knowledge/`) is a force-directed map
   (`features/knowledge-graph` — canvas-2D, pan/zoom/drag, search, per-type filters, reindex for `settings:write`,
   at most 260 laid-out nodes). Picking a node opens its identity and relationships in the split-view panel's
   `knowledge` tab, which reads the map the screen published, so map and detail cannot disagree. The entry library
   with create/edit/verify, extraction and file history is `/[workspace]/knowledge` (`features/manage-knowledge`).
   The map's invariants:
   - **The knowledge layer is read LIVE, never awaited from a reindex** — `KnowledgeService.graph` overlays a fresh
     projection of workspace-visible, non-proposed entries and skills on top of the persisted BFS. Harvest ids are
     deterministic, so the overlay reconciles with an already-harvested graph. Only the ENTITY stratum waits for a
     reindex.
   - **A pin whose entity is not projected yet becomes a `dangling` reference node**, so a claim is never an orphan
     dot.
   - **`graph()` is a RENDER model, not a dump of the spine.** It ships only edges with a node row on BOTH ends, and
     its edge is the render shape `KnowledgeGraphEdge` rather than the stored `EdgeMention`: the audit fields
     (origin / extractor / confidence / evidencePath / sourceKind / sourceId / tenant / createdAt) were two thirds of a
     640 KB response on a ~250-node workspace. Provenance belongs to `related`, `node` and `listMentions` — don't
     "restore" those fields here; add a provenance read.

## What is not built

- **Ingest-on-write** — `ingestHarvest` is called only by `reindex`, so the entity stratum is as current as the last
  reindex.
- **Mention-spine extraction and resolution** — no extractor writes `extraction`-origin mentions from comments, agent
  messages or PR comments, and no resolver moves a `pending` mention to `resolved`.
- **A reduce layer** — nothing aggregates evidence across mentions into node rows or validates predicate shapes.
- **Harvesters** for `view`, `browser_profile`, `trace_source`, `agent_session`, `repository`, `runner`, `image`,
  `case`, `comment`, `membership` and `capability` records.
- **A coverage-gap agenda** — coverage is computed per listing and per context request; nothing collects the gaps.

## References

- Reference system: `workspaces/digo-data` — `platform/digo_data/core/travel_knowledge/contracts/{mention_v1,edge_mention_v1}.py`
  and the `digo-travel-knowledge` skill.
- User-facing guide: [guide/workspace/agent-context.md](../guide/workspace/agent-context.md).
