---
kind: wiki
title: "Workspace Knowledge Graph"
status: current
updated: 2026-08-11
anchors: [packages/contracts/src/records/agent-session.ts]
---
# Workspace Knowledge Graph

> **SSOT** for everdict's knowledge system. Status: **the backend + API/MCP surface + the authored write path are
> landed** — the contract spine; the `KnowledgeStore` (in-memory + Postgres); the multi-hop query engine; eighteen
> harvesters (scorecard/run/schedule/comment/membership + issue/project/initiative/team/cycle + harness/dataset/judge/
> runtime/model/rubric/agent/capability); and the `knowledge/` HTTP + MCP slice — read (node/related/subgraph/
> annotations) + `reindex` + the **authored write path** (`annotate`/`relate`) so a user or agent contributes knowledge
> from Claude Code via the everdict plugin. The graph is centred on the **intent stratum** (§The intent stratum): the
> issue is the hub, and execution records are evidence admitted by reference, not inventory.
> The workspace-facing **map** (Settings › Knowledge) is landed too; text extraction + resolution and ingest-on-write
> are next (see §Roadmap).

Everdict's data is a web of relationships that today is only *implicit* — a scorecard's config names a harness,
dataset, judges, and a runtime; a comment @-mentions a user and discusses a scorecard; an agent's reasoning talks
about which harness to evaluate; a secret is referenced by six specs; a repository triggers a harness on every PR.
The **workspace knowledge graph** makes that web *explicit and queryable*: a single, type-agnostic layer of **nodes**
(the domain entities) and **edges** (their relationships) that any surface — a resource detail page, the agent, an
impact-analysis view, a "what uses this secret" query — reads through one multi-hop engine.

This is a deliberate **reinterpretation of the `travel_knowledge` knowledge system in `workspaces/digo-data`**, not a
copy. That system extracts a 6-axis travel graph from unstructured UGC through a type-agnostic `mention` /
`edge_mention` spine. We keep its proven design locks and adapt the one axis that differs: everdict's entities are
already structured and already own canonical identity, so most of the graph is *harvested deterministically* rather
than *extracted from text*.

## The reinterpretation at a glance

| digo-data `travel_knowledge` | everdict knowledge graph |
| --- | --- |
| `stg_post` — normalized UGC post (the source document) | **source** — an everdict artifact that carries references (a scorecard, run, comment, agent turn, spec, …), named by `(sourceKind, sourceId)`; not copied, just cited |
| `mention` — an LLM-extracted *surface* reference (`entity_ref`), resolved later | **`Mention`** — one observed reference to a node. Mostly a **deterministic harvest** of a structured record field (`origin: "harvest"`, `confidence` 1.0, born resolved); text surfaces are **extracted** (`origin: "extraction"`, `confidence` < 1, resolved downstream) |
| `edge_mention` — a `(subject, predicate, object)` triple | **`EdgeMention`** — same, with the same two reference styles (by mention id XOR by node id) |
| per-type entity mart — the canonical entity | **`KnowledgeNode`** — a lightweight canonical *projection* of an existing record (one type-agnostic table, since everdict entities already have identity) |

The contracts live in [`packages/contracts/src/knowledge/`](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/).

## The three layers

```
  everdict domain records
  (scorecards, runs, comments, specs, schedules, agent turns, settings …)
        │
        │  HARVEST (structured FKs, deterministic)   +   EXTRACTION (free text, agent/regex)
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  MENTION SPINE  (type-agnostic, append-only, auditable)      │
  │    Mention       — node_type + node_ref + node_attrs         │
  │    EdgeMention   — predicate + subject + object + polarity   │
  └─────────────────────────────────────────────────────────────┘
        │  resolve (surface → canonical)  +  reduce (aggregate evidence)
        ▼
  KnowledgeNode  (canonical projection)   ── multi-hop query engine ──▶  rendering engine
```

### Layer 0 — Sources

A **source** is the everdict artifact a reference was observed *in*. It is the analog of `stg_post`, but everdict does
**not** materialize a normalized copy — the source already exists as a domain record, so a mention just carries the
`(sourceKind, sourceId)` provenance tuple. That tuple is the **audit lock**: every mention and edge is traceable back
to exactly what produced it.

Sources split into two families, distinguished by `MentionOrigin`:

- **Structured** (`scorecard`, `run`, `schedule`, `*_spec`, `view`, `membership`, `workspace_settings`) →
  **harvested**: a deterministic projection of record foreign-keys. A `ScorecardRecord` alone yields
  `scorecard -[evaluates]-> harness`, `-[uses_dataset]-> dataset`, `-[applies_judge]-> judge` (×N),
  `-[runs_on]-> runtime`, `-[fired_by]-> schedule`, `-[created_by]-> user`, `-[child_of]<- run` (×N). Confidence is
  `1.0`; the mention is born `resolved`; the evidence is the JSON field path (`evidencePath`, e.g. `origin.scheduleId`).
- **Text** (`comment`, `agent_message`, `pr_comment`) → **extracted**: an agent or a regex pulls references out of
  free text. `nodeRef` is a surface form, `confidence` < 1, resolution is deferred, and the evidence is the text
  excerpt (`evidenceQuote` + offsets).

The `SourceKind` vocabulary overlaps but is **not** identical to `NodeType`: a scorecard is both a node and a source;
`workspace_settings` is a source but not a node; `tag`/`metric`/`image` are nodes but never sources. Adding a source is
a new harvester/extractor adapter with the spine unchanged — the digo lock.

### Layer 1 — The mention spine (this step's deliverable)

Two type-agnostic tables, mirroring digo-data. **This is what "define the node and the mention/edge_mention" means**,
and it is what step 1 lands as Zod contracts.

**`Mention`** ([mention.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/mention.ts)) — one observed reference to a node:

- `nodeType` + `nodeRef` + `nodeAttrs` (jsonb) — *type-agnostic*: one shape carries every node type; type-specific
  hints go in `nodeAttrs`, never per-type columns. Adding a node type never touches this schema.
- `sourceKind` + `sourceId` — provenance.
- `origin` (`harvest` | `extraction`) + `extractor` + `confidence` — how it was drawn out.
- `evidencePath` (harvest) / `evidenceQuote` + offsets (extraction) — the **audit lock**, enforced in the schema.
- `resolution` (`resolved` | `pending` | `unresolved`) + `resolvedNodeId` — surface → canonical.

**`EdgeMention`** ([edge-mention.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/edge-mention.ts)) — one observed
relationship:

- `predicate` + `subject*` + `object*` + `edgeAttrs` (jsonb) + `polarity` (promoted first-class).
- **Two reference styles**, exactly one per side (XOR, enforced): `*MentionId` (one-shot / pre-resolution) or
  `*NodeId` (two-step / post-resolution) — digo's `idx` XOR `canonical_id`.
- Same provenance, origin, confidence, evidence, and resolution fields as `Mention`.

Invariants inherited from digo-data and enforced or documented here:

1. **Type-agnostic wire** — never a per-node-type mention table or a per-predicate edge table. Vocabulary is the
   extension axis.
2. **Append-only + auditable** — a mention/edge is never mutated; a re-harvest or re-extraction with a newer
   `extractor` appends a new row. Deterministic ids make harvest idempotent.
3. **Surface-then-resolve** — `nodeRef` is what the source said; canonicalization is a recorded downstream step.
4. **Polarity survives** — a `negated` edge ("scorecard regressed against baseline", "run did NOT cover the case") is
   never dropped; the reduce layer surfaces contradictions instead of averaging them into false consensus.

### Layer 2 — Nodes

**`KnowledgeNode`** ([knowledge-node.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/knowledge-node.ts)) is the canonical
projection of a domain entity — digo's per-type entity mart, collapsed into **one** type-agnostic table because
everdict entities already own identity. It is a *derived read-model*: the reduce layer rebuilds it from the mentions
that resolve to it, aggregating evidence. It never duplicates a record's body — only a display `label` and a small
`attrs` bag so a graph render draws the node without re-fetching.

- **Node identity** is version-pinned and content-addressed: `nodeId = derive(type, tenant, key, version?)`. Harness
  `web@1.0.0` and `web@2.0.0` are **distinct nodes** joined by a `succeeds` edge; the version-agnostic `key` groups a
  family. The derivation helper is pure and lives in `@everdict/domain` (contracts stay logic-free).
- **`NodeRef`** (`{type, key, version?}`) is the structural handle — the generalization of the existing
  [`AgentReference`](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/agent-session.ts) (`{type,id,version,label}`) that user
  turns already carry. `AgentMessageRecord.references[]` is therefore a **ready-made harvest source** for the
  `references` predicate.

## Node vocabulary (closed, PR-gated)

`NODE_TYPES` ([node-type.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/node-type.ts)) — 32 types by axis. The vocabulary
is **closed**: inventing a type is a code change, never a runtime value. Because the spine is type-agnostic, adding one
is a one-line enum extension plus a harvester — the same cheap axis digo grew 14 → 17 on.

| Axis | Node types |
| --- | --- |
| **Actors (WHO)** | `workspace`, `user` |
| **Intent (WHY — the hub)** | `issue`, `project`, `initiative`, `team`, `cycle` |
| **Under test (versioned)** | `harness`, `dataset`, `case`, `judge`, `rubric`, `model`, `agent`, `capability` |
| **Execution infra (WHERE)** | `runtime`, `runner`, `image` |
| **Execution & outcomes (WHEN)** | `run`, `scorecard`, `schedule` |
| **Analysis** | `tag`, `metric`, `view` |
| **Knowledge & comms** | `skill`, `knowledge`, `comment`, `agent_session` |
| **Integration & external** | `repository`, `trace_source`, `secret`, `browser_profile` |

Deliberately **not** nodes: `member` (an edge, `member_of`), `notification` / `budget` / `usage` (projections /
metering, downstream of the graph), `workspace_settings` (a source whose sub-objects become edges).

## Predicate vocabulary (closed, PR-gated)

`PREDICATES` ([predicate.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/predicate.ts)) — 41 predicates by axis. **Direction
is fixed**: an edge points FROM the dependent/referencing node TO the referenced node. The `typical (subject → object)`
shapes are conventions the harvesters emit, not wire enforcement — per-predicate validation is a downstream (reduce)
concern, keeping the vocabulary the single extension axis.

| Axis | Predicates (typical subject → object) |
| --- | --- |
| **Provenance** | `created_by` (any → user), `member_of` (user → workspace, role in `edgeAttrs`), `in_workspace` (any → workspace) |
| **Intent** | `verified_by` (issue → harness/dataset/judge/scorecard/run/view — an issue link; note in `edgeAttrs`), `resolved_by` (issue → scorecard — the closing evidence and regression baseline), `part_of` (issue → project/cycle; project → initiative; initiative/team → parent), `belongs_to` (issue/cycle/project/spec → team), `assigned_to` (issue → user; project/initiative lead with `edgeAttrs.role`), `born_from` (capability version → issue/project/scorecard/… — `CapabilityOrigin.from`) |
| **Eval composition** | `evaluates` (scorecard/run → harness), `uses_dataset`, `includes_case` (dataset → case), `covers_case` (run → case), `applies_judge`, `uses_rubric` (judge → rubric), `uses_model`, `runs_on` (→ runtime), `placed_on` (run → runner), `child_of` (run → scorecard; sub-issue → parent issue), `fired_by` (scorecard → schedule) |
| **Results & measurement** | `measures` (→ metric; value/pass in `edgeAttrs`), `compared_to` (scorecard ↔ scorecard diff), `supersedes` (scorecard → scorecard) |
| **Lineage** | `succeeds` (entity@vN → @vN-1), `derived_from` (dataset → dataset, instance → template) |
| **Agent & comms** | `adopts` (agent → capability), `references` (agent turn → any), `discusses` (comment → resource), `reply_to` (comment → comment), `mentions` (→ user) |
| **Knowledge** | `about` (skill/knowledge → any — what a claim/procedure concerns), `evidenced_by` (knowledge → scorecard/run/comment/agent_session — the evidence trail) |
| **Integration** | `triggers` (repository → harness), `connects_repo` (workspace → repository), `pins_image` (harness → image), `runs_image` (case/run → image), `exports_to` / `pulls_from` (harness → trace_source), `uses_secret` (any → secret), `uses_browser_profile` |
| **Classification** | `tagged_with` (any → tag) |

`uses_secret` deserves note: it turns the existing secret-usage feature into a first-class graph query ("what
references this secret"), and `pins_image` / `runs_image` do the same for image provenance — showing the payoff of a
unified graph over point features.

## The intent stratum — the issue as hub

The graph's first design was FLAT: 27 node types rendered as equals, which let the high-cardinality execution
records (every run, every scorecard) drown the strata a workspace actually reads the map for. The re-design adds the
**intent stratum** — the eval tracker ([docs/tracker.md](../tracker.md)) — and re-centres the graph on it: the
**issue is the hub**, because it is the one record whose whole job is to gather the others ("what verifies this
problem, what closed it, why did it come back").

Three strata, with a deliberate tiering:

1. **Intent (WHY)** — `issue` / `project` / `initiative` (+ `team` / `cycle` as organisational scoping). Harvested
   whole from the tracker stores ([harvest-tracker.ts](https://github.com/everdict/everdict/blob/main/packages/domain/src/knowledge/harvest-tracker.ts)):
   an issue's links become `verified_by` edges (version pin + note preserved), its resolution `resolved_by` (the
   regression baseline), its plan coordinates `part_of` (project/cycle) + `child_of` (parent issue) +
   `belongs_to` (team) + `assigned_to` (assignee; project/initiative leads carry `edgeAttrs.role: "lead"`).
2. **Capability (WHAT)** — the versioned eval subjects/config, unchanged, plus the **`born_from` lineage**: a
   registered version's `CapabilityOrigin.from` (stored per-version in the registries, exposed on list entries as
   `versionOrigins`) becomes `harness/dataset/judge/… -[born_from]-> issue|scorecard|…` — "which issue was this
   judge built to evaluate" is now a graph query. Registry `teamId` metadata adds the spec's `belongs_to` edge.
3. **Execution (EVIDENCE — demoted)** — run/scorecard records are materialised **only while something references
   them**: an issue link, an issue resolution, a knowledge entry's refs/evidence, a skill's refs, or a capability
   origin. Reindex collects those references first, harvests only the referenced execution records, and **prunes**
   execution nodes whose reference went away (per type, only when that type's source is wired). The node table is a
   derived read-model, so retraction is within contract; the append-only mention/edge spine is never touched — the
   audit trail survives, and a re-referenced record re-materialises idempotently on the next reindex. The accepted
   trade-off: "recent runs of this harness" is a `RunStore` question, not a graph question — the graph's execution
   nodes are evidence, not inventory.

Because the spine is type-agnostic, the moment `issue` became a NodeType the existing machinery lit up for free:
`harvestComment`'s `NodeTypeSchema.safeParse` now yields `comment -[discusses]-> issue` for issue threads; knowledge
entries and skills can pin issues (`about` / `evidenced_by`); and the infra panel's "Ask in chat" button works on
issue nodes (`AGENT_REFERENCE_TYPES` already carried `issue` → `get_issue`).

Deliberately NOT projected (follow-ups): issue `labelIds` (registry ids — a tag node labelled by a UUID says
nothing; needs label-name resolution at harvest time) and team roster edges (`member_of` runs user → team, but the
`HarvestBuilder` emits self → object only — the same reason `harvestMembership` materialises the USER node).

## The knowledge layer — claims over predicates

The vocabulary above mirrors the entity schema: it answers *"what is wired to what"* (config topology, provenance,
usage) and is deliberately specific, because every one of those edges is a deterministic FK projection. What it cannot
express is a **claim about entities** — "harness `web-agent@2.x` is flaky on login cases when run on k8s", "we chose
rubric-based judging over judge X; the A↔B diff is the evidence". Trying to encode claims in the predicate vocabulary
would force it open (breaking the closed-vocab lock); giving up leaves free-text notes (`annotate`) that cannot carry
revision, evidence, or multi-entity anchoring.

The resolution is to **move the specificity from the edge into the node** (reification): a claim is a first-class
`knowledge` node whose *content* carries the specifics, and the graph only records what the claim concerns (`about`)
and what backs it (`evidenced_by`). The structural stratum keeps its specific, closed 33-predicate grammar; the
knowledge stratum uses a deliberately GENERIC grammar — two predicates, rich nodes:

```
knowledge:"login cases flaky on k8s"
   -[about]->        harness:web-agent@2.1.0
   -[about]->        runtime:k8s-prod
   -[evidenced_by]-> scorecard:abc123
   -[evidenced_by]-> comment:thread-42
```

### Knowledge entries

A **`KnowledgeEntryRecord`** ([knowledge-entry.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/knowledge-entry.ts)) is the
record behind a `knowledge` node — the promoted successor of an `annotate` note (which stays as the lightweight margin
note). It is workspace-general, high-level knowledge NOT bound to one task: `kind` (`finding` | `decision` |
`convention` | `context` — a thin classifier, not a workflow), a one-line `title` (the node label — the claim itself),
a markdown `body` (where the specificity lives), `refs: NodeRef[]` (→ `about` edges), `evidence: NodeRef[]`
(→ `evidenced_by` edges), `status` (`active` | `superseded` | `deprecated`) + `supersedes` (knowledge has revision
lineage too), the `private | workspace` visibility vocabulary, and `verifiedAt` (last time a human/agent confirmed the
claim still holds — distinct from `updatedAt`, because knowledge rots even when untouched). A deterministic harvester
projects entries into the graph like any other record.

Deliberately NOT in v1: per-kind structured claim schemas (that is the too-specific trap again — free text + anchors +
evidence is the right grain), argumentation predicates (`supports`/`contradicts` — edge `polarity` already carries
negation; defer until needed), and embedding search (structural adjacency first — the anchors are already structured).

### The time axis — intervals, not decay

Knowledge has COORDINATES: a **space axis** (which entity family a claim concerns — `(type, key)`) and a **time axis**
(which point of that entity's timeline it is about — a *version* for versioned entities, a *timestamp* for continuous
ones; assertion time — when the workspace learned it — is a third, always-wall-clock signal via
`createdAt`/`verifiedAt`). The graph's version-pinned node id (`harness:acme:web-agent@2.1.0`) already IS that
spacetime coordinate. Crucially, **time is a coordinate, not decay**: a claim pinned at `web-agent@2.1.0` stays true
ABOUT 2.1.0 forever — the open question is whether its validity *extends* to a given coordinate, and that is itself a
recorded fact.

The pin is therefore an INTERVAL, not a point: **`KnowledgePin = NodeRef + { verifiedVersion? }`**
([knowledge-node.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/knowledge/knowledge-node.ts)) — the known-valid interval
`[version, verifiedVersion]`. `version` is the subject-time point the knowledge was observed at (immutable — the
origin is history, never overwritten); `verify` EXTENDS `verifiedVersion` to each pinned family's current latest (a
coordinate extension along subject time, plus the wall-clock `verifiedAt`; `updatedAt` untouched — verification is not
an edit). Client edits author plain `NodeRef`s; `verifiedVersion` is system-owned and carried over server-side when
the `(type, key, version)` triple is unchanged (a re-pin starts a fresh point interval). Closing an interval needs no
field: a superseding entry **pinned at the version where the behavior changed** closes the old claim's interval by
derivation — and the `supersedes` chain is the workspace's knowledge *trajectory*, not noise. The `about` edges carry
the interval in `edgeAttrs` (`{asOf, verifiedVersion}`), so it is readable from the graph without fetching the record.

Both vocabularies live in the pure kernel ([freshness.ts](https://github.com/everdict/everdict/blob/main/packages/domain/src/knowledge/freshness.ts)) and are
deliberately NOT merged — they answer different questions:

- **Coverage** (record vs the entity's PRESENT, for listings/badges): `current | behind | unverified` —
  `assessCoverage` compares each pin's interval end against the family's latest (resolved from the registries today;
  a graph-native `succeeds` join can back the same resolver seam later). `behind` means "as-of an earlier point;
  validity at the present unknown" — never "wrong". A `behind` item has THREE legitimate outcomes: verify (extend),
  supersede (close, pinned at the change point), or leave as history — a valid record, not an error to clean up.
- **Anchor relation** (record vs an ANCHOR coordinate, for context assembly): `covers | earlier | later | general` —
  `anchorRelation` positions the interval against a projection coordinate (below).

Skills join the same model: a **Skill** ([skill.ts](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/skill.ts)) is the
task-oriented complement ("how do I do this" vs an entry's "what is true / why we decided"), its `refs` are the same
`KnowledgePin[]`, and the skill listing/`use_skill` banner surface its coverage as *as-of coordinates*
("documented @2.1.0, verified through 2.2.0 · current 2.3.0"), steering the agent to the three responses. Skill
selection reuses the `about` edges: skills adjacent to the task's anchors rank up — structural adjacency, no
embeddings.

### Consumption converges on `assembleContext` — as-of projection

The point of the layer is context assembly for agents — everdict's own agent, spawned teammates/subagents, and
developers' Claude Code sessions via the plugin (MCP `get_task_context`). One service feeds all three, and **the
anchor's own version IS the as-of coordinate** (no separate parameter): an unversioned anchor resolves to the family's
latest (present-projection); analyzing a month-old scorecard, its `harness@2.1.0` anchor projects the knowledge base
onto that point — the analysis runs on the knowledge that was valid *then*, plus the `later` trail of what happened
next.

```
assembleContext(anchors: NodeRef[]) →                      anchor.version ?? latest = the projection coordinate
  1. structural facts:  relatedFacts(anchors)               (graph; includes the comments' discusses trail)
  2. knowledge:         entries family-matched to anchors,  each labeled relation ∈ covers|earlier|later|general
  3. skill candidates:  skills  family-matched to anchors,  same labels; listing-level only (no body)
```

Ranking is **relation > status > recency**: at a past coordinate, a SUPERSEDED claim that `covers` it is that
coordinate's truth and outranks an `active` claim from the coordinate's future — the "old/superseded is inferior"
assumption is removed from ranking too. Every item also carries its present-coverage state.

This is the substance of "knowledge migration into everdict": the moment a developer's Claude Code pulls task context
from the workspace graph instead of a local CLAUDE.md, the workspace — not the individual — owns the knowledge.

### The accumulation loop

The three origins already cover how the layer fills: **harvest** (structural facts accrue for free; the skill/knowledge
harvesters project `refs`), **authored** (`create_knowledge` / `update_skill` via MCP + the in-product agent, whose
system prompt already directs it to record durable observations — promoted from `annotate` to entries; after a task
that used a skill, the agent proposes a revision when the procedure and reality diverged — HITL via the existing edit
path), and **extraction** — ✅ shipped for comment threads: `POST /knowledge/extract` / MCP `extract_knowledge` (member+, a registered-model call like skill-generate) mines a thread for durable conclusions via `KnowledgeExtractionService` and stores them as `proposed` entries (extractor-sentinel authored, workspace-visible, `extraction` provenance = the (sourceKind, sourceId) audit tuple + confidence; the discussed resource auto-anchors `refs`, the thread is the `evidence`; re-runs dedupe by source+title). Review is the HITL promotion: `approve_knowledge_entry` flips proposed → active AND transfers authorship to the approver ("promoted to authored on approval" — the provenance survives for audit); `reject_knowledge_entry` deletes the candidate. Proposed entries stay OUT of the graph reindex and of `assembleContext` — an unreviewed candidate is not workspace knowledge yet. Next: agent-session sources + an event-driven trigger (thread close → extract) over the platform-event log. The coverage computation feeds a **coverage-gap
agenda** (next): a periodic review list of the points where entity evolution outpaced knowledge coverage — NOT a
"stale, go fix it" alarm, since each gap has three legitimate outcomes (extend / close / leave as history); the
improvement trigger is the graph's state, not someone's memory.

## Where the code lives

Following everdict's one-way spine (no new package — schemas belong at the contract root):

| Concern | Package |
| --- | --- |
| Schemas (node/mention/edge, closed vocabularies) — **this step** | `@everdict/contracts` (`src/knowledge/`) |
| Node-id derivation, graph algebra, multi-hop traversal, reduce | `@everdict/domain` (pure) |
| `KnowledgeStore` port + `InMemory*` / `Pg*` impls + migrations | `@everdict/db` |
| Harvest / extract / resolve use-cases | `@everdict/application-control` |
| HTTP + MCP surface (graph queries) | `apps/api` |
| Rendering | `apps/web` |

## Roadmap

1. ✅ **Storage** — the `KnowledgeStore` port (`application-control`) + `InMemoryKnowledgeStore` / `PgKnowledgeStore`
   (`db`, migration `0076`): append-only mention/edge tables (idempotent by id) + an upsert-by-node_id node table.
2. **Harvesters** — deterministic projectors, one per structured source kind, built on the shared `HarvestBuilder`.
   ✅ the record harvesters `scorecard` / `run` / `schedule` / `comment` / `membership` (`membership` materialises the
   `user` node) and the registry-spec harvesters `harness` / `dataset` / `judge` / `runtime` / `model` / `rubric` /
   `agent` / `capability` (which take a `SpecHarvestMeta` since a spec carries no tenant/timestamp; they also pull
   `uses_model` / `uses_rubric` / `uses_secret` / `adopts` — the secret-usage + capability-adoption graph, incl.
   cross-tenant `adopts` via `HarvestBuilder.ref`'s `objectTenant`). Every core scorecard edge resolves to a
   materialised node, and every referenced eval-config node has an owning harvester. ✅ the knowledge-layer harvesters
   `skill` / `knowledge_entry` (projecting `refs` → `about`, `evidence` → `evidenced_by`). ✅ the intent-stratum
   harvesters `issue` / `project` / `initiative` / `team` / `cycle` (§The intent stratum — the issue hub's
   `verified_by` / `resolved_by` / `part_of` / `belongs_to` / `assigned_to` edges, plus `born_from` via
   `SpecHarvestMeta.origin` on every registry-spec harvester). Remaining (low-fan-in leaves): `view` /
   `browser_profile` / `trace_source` / `agent_session`. Idempotent, versioned by `extractor`.
3. **Contribution & extraction** — ✅ the AUTHORED write path (`annotate` / `relate`, origin `authored`): a user or
   agent contributes knowledge from Claude Code via the everdict MCP plugin, AND ✅ the **in-product conversational
   agent** (`apps/agent`) drives the same path — the `annotate_knowledge` / `relate_knowledge` tools are in its default
   tool surface (HITL-gated writes; the knowledge reads `get_knowledge_graph` / `knowledge_related` / `knowledge_subgraph`
   / `knowledge_notes` are read-only), and its system prompt directs it to consult the graph and record durable,
   evidence-backed observations as it works, so the workspace's institutional knowledge accumulates from in-product use
   too. With the knowledge layer, the prompt now steers the full loop: `get_task_context` opens an entity-anchored
   task, durable conclusions are recorded as knowledge ENTRIES (`create_knowledge_entry`, annotate demoted to margin
   notes), and coverage is maintained in-band (`verify_skill` / `verify_knowledge_entry` when a behind-flagged item
   still holds — an interval extension; a superseding revision pinned at the change point when it drifted; or left as
   a valid historical record). An authored note is a mention resolved to its node (read back via `GET /knowledge/annotations`); an authored
   relation is an edge over the closed predicate vocabulary (read back via `related`/`subgraph`), idempotent by (author,
   subject, predicate, object). The `authored` origin lets a query separate what the system DERIVED from what a person
   (or their agent) ASSERTED. Next: text EXTRACTORS for `comment` / `agent_message` / `pr_comment` (@-mention regex
   first, agent extraction later) + a resolver (surface `nodeRef` → `resolvedNodeId`).
4. ✅ **Multi-hop query engine** — `KnowledgeQueryService` (`application-control`): `subgraph` (BFS by depth /
   direction / predicate / node-type over the store's single-hop primitives) + `relatedFacts` (ranked 1-hop flat facts
   for rendering, the `mentionGrounding` / `cityKnowledge` analog). A Pg-native recursive-CTE fast path can slot in
   behind the same surface later.
5. ✅ **API + MCP** — an isolated `knowledge/` slice: `GET /knowledge/node|related|subgraph` + `POST /knowledge/reindex`
   (read = `scorecards:read`; reindex = `settings:write`) and the four matching MCP tools, over a `KnowledgeService`
   facade. The `KnowledgeStore` is `InMemory`/`Pg` by `DATABASE_URL`; `reindex` is a pull harvest of the tracker
   stores (issues/projects/initiatives/teams/cycles), the record stores (schedules, plus runs/scorecards under the
   execution-admission rule), AND the registries (dataset/judge/runtime/model/rubric/harness/agent, at each entity's
   latest version, with `versionOrigins`/`teamId` registry metadata) — so a reindex materialises the intent stratum
   and every eval-config node, while execution records enter only by reference and stale execution nodes are PRUNED
   (`KnowledgeStore.listNodeIds`/`deleteNodes`; §The intent stratum). Write-path ingest-on-write (keeping the graph
   current without a manual reindex) is the follow-up.
6. **Rendering** — ranked flat fact lists first (resource "related" panels, impact analysis, the agent's context),
   ✅ plus the **map** the workspace reads: Settings › Knowledge is a force-directed graph of the knowledge layer over
   the entities it concerns (`features/knowledge-graph` — canvas-2D, pan/zoom/drag, search, per-type filters), and
   picking a node opens its identity + surrounding relationships in the split-view panel's `knowledge` tab, which
   reads the map the screen published (map and detail can never disagree). Two invariants make the map honest:
   - **The knowledge layer is read LIVE, never awaited from a reindex** — `KnowledgeService.graph` overlays a fresh
     projection of the workspace-visible entries + skills (the same records `assembleContext` reads) on top of the
     persisted BFS. Harvest ids are deterministic, so the overlay reconciles with an already-harvested graph. A claim
     written a minute ago is on the map; only the ENTITY stratum waits for a reindex.
   - **A pin whose entity is not projected yet becomes a `dangling` reference node**, drawn hollow. A claim is never
     stranded as an orphan dot just because nothing has harvested the harness it is about.
   - **`graph()` is a RENDER model, not a dump of the spine.** It ships only edges with a node row on BOTH ends (an
     edge to an unmaterialised endpoint can be neither drawn nor listed — on a real workspace that scoping star,
     `in_workspace` + `created_by`, was ~half of them), and its edge is an explicit render shape
     (`KnowledgeGraphEdge`) rather than the stored `EdgeMention`: the audit spine (origin / extractor / confidence /
     evidencePath / sourceKind / sourceId / tenant / createdAt) was two thirds of the bytes and belongs to the
     surfaces that answer provenance questions — `related`, `node`, `listMentions`. Measured on a 265-node
     workspace: 640 KB → 242 KB, LCP 4.2 s → 1.0 s. Don't "restore" those fields here; add a provenance read.
   Still open: ingest-on-write hooks so the entity stratum stays current without a manual reindex.
7. **Knowledge layer (v1)** — §The knowledge layer: the `knowledge` node type + `about`/`evidenced_by` predicates,
   `KnowledgeEntryRecord` (store + CRUD + MCP parity + harvester), `SkillRecord.refs`/`verifiedAt` + the skill
   harvester, coverage surfaced in the skill listing / `use_skill`, and `assembleContext` + MCP `get_task_context`
   — ✅ plus the TIME-AXIS revision (§The time axis): interval pins (`KnowledgePin.verifiedVersion`), verify as
   coordinate extension, anchor-relative projection (`covers | earlier | later | general`) with relation-first
   ranking, and the coverage vocabulary (`current | behind | unverified`) across every surface. Next:
   extraction-based entry proposals from closed comment threads / agent sessions, the coverage-gap agenda, and the
   entity-timeline web view.

## References

- Reference system: `workspaces/digo-data` — `platform/digo_data/core/travel_knowledge/contracts/{mention_v1,edge_mention_v1}.py`
  and the `digo-travel-knowledge` skill.
- Existing proto-mention: `AgentReference` / `AgentMessageRecord.references[]` in
  [`packages/contracts/src/records/agent-session.ts`](https://github.com/everdict/everdict/blob/main/packages/contracts/src/records/agent-session.ts).
