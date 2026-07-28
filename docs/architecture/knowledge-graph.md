# Workspace Knowledge Graph

> **SSOT** for everdict's knowledge system. Status: **the backend + API/MCP surface + the authored write path are
> landed** — the contract spine; the `KnowledgeStore` (in-memory + Postgres); the multi-hop query engine; thirteen
> harvesters (scorecard/run/schedule/comment/membership + harness/dataset/judge/runtime/model/rubric/agent/capability);
> and the `knowledge/` HTTP + MCP slice — read (node/related/subgraph/annotations) + `reindex` + the **authored write
> path** (`annotate`/`relate`) so a user or agent contributes knowledge from Claude Code via the everdict plugin.
> Text extraction + resolution, ingest-on-write, and web rendering are next (see §Roadmap).

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

The contracts live in [`packages/contracts/src/knowledge/`](../../packages/contracts/src/knowledge/).

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

**`Mention`** ([mention.ts](../../packages/contracts/src/knowledge/mention.ts)) — one observed reference to a node:

- `nodeType` + `nodeRef` + `nodeAttrs` (jsonb) — *type-agnostic*: one shape carries every node type; type-specific
  hints go in `nodeAttrs`, never per-type columns. Adding a node type never touches this schema.
- `sourceKind` + `sourceId` — provenance.
- `origin` (`harvest` | `extraction`) + `extractor` + `confidence` — how it was drawn out.
- `evidencePath` (harvest) / `evidenceQuote` + offsets (extraction) — the **audit lock**, enforced in the schema.
- `resolution` (`resolved` | `pending` | `unresolved`) + `resolvedNodeId` — surface → canonical.

**`EdgeMention`** ([edge-mention.ts](../../packages/contracts/src/knowledge/edge-mention.ts)) — one observed
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

**`KnowledgeNode`** ([knowledge-node.ts](../../packages/contracts/src/knowledge/knowledge-node.ts)) is the canonical
projection of a domain entity — digo's per-type entity mart, collapsed into **one** type-agnostic table because
everdict entities already own identity. It is a *derived read-model*: the reduce layer rebuilds it from the mentions
that resolve to it, aggregating evidence. It never duplicates a record's body — only a display `label` and a small
`attrs` bag so a graph render draws the node without re-fetching.

- **Node identity** is version-pinned and content-addressed: `nodeId = derive(type, tenant, key, version?)`. Harness
  `web@1.0.0` and `web@2.0.0` are **distinct nodes** joined by a `succeeds` edge; the version-agnostic `key` groups a
  family. The derivation helper is pure and lives in `@everdict/domain` (contracts stay logic-free).
- **`NodeRef`** (`{type, key, version?}`) is the structural handle — the generalization of the existing
  [`AgentReference`](../../packages/contracts/src/records/agent-session.ts) (`{type,id,version,label}`) that user
  turns already carry. `AgentMessageRecord.references[]` is therefore a **ready-made harvest source** for the
  `references` predicate.

## Node vocabulary (closed, PR-gated)

`NODE_TYPES` ([node-type.ts](../../packages/contracts/src/knowledge/node-type.ts)) — 27 types by axis. The vocabulary
is **closed**: inventing a type is a code change, never a runtime value. Because the spine is type-agnostic, adding one
is a one-line enum extension plus a harvester — the same cheap axis digo grew 14 → 17 on.

| Axis | Node types |
| --- | --- |
| **Actors (WHO)** | `workspace`, `user` |
| **Under test (versioned)** | `harness`, `dataset`, `case`, `judge`, `rubric`, `model`, `agent`, `capability` |
| **Execution infra (WHERE)** | `runtime`, `runner`, `image` |
| **Execution & outcomes (WHEN)** | `run`, `scorecard`, `schedule` |
| **Analysis** | `tag`, `metric`, `view` |
| **Knowledge & comms** | `skill`, `knowledge`, `comment`, `agent_session` |
| **Integration & external** | `repository`, `trace_source`, `secret`, `browser_profile` |

Deliberately **not** nodes: `member` (an edge, `member_of`), `notification` / `budget` / `usage` (projections /
metering, downstream of the graph), `workspace_settings` (a source whose sub-objects become edges).

## Predicate vocabulary (closed, PR-gated)

`PREDICATES` ([predicate.ts](../../packages/contracts/src/knowledge/predicate.ts)) — 35 predicates by axis. **Direction
is fixed**: an edge points FROM the dependent/referencing node TO the referenced node. The `typical (subject → object)`
shapes are conventions the harvesters emit, not wire enforcement — per-predicate validation is a downstream (reduce)
concern, keeping the vocabulary the single extension axis.

| Axis | Predicates (typical subject → object) |
| --- | --- |
| **Provenance** | `created_by` (any → user), `member_of` (user → workspace, role in `edgeAttrs`), `in_workspace` (any → workspace) |
| **Eval composition** | `evaluates` (scorecard/run → harness), `uses_dataset`, `includes_case` (dataset → case), `covers_case` (run → case), `applies_judge`, `uses_rubric` (judge → rubric), `uses_model`, `runs_on` (→ runtime), `placed_on` (run → runner), `child_of` (run → scorecard), `fired_by` (scorecard → schedule) |
| **Results & measurement** | `measures` (→ metric; value/pass in `edgeAttrs`), `compared_to` (scorecard ↔ scorecard diff), `supersedes` (scorecard → scorecard) |
| **Lineage** | `succeeds` (entity@vN → @vN-1), `derived_from` (dataset → dataset, instance → template) |
| **Agent & comms** | `adopts` (agent → capability), `references` (agent turn → any), `discusses` (comment → resource), `reply_to` (comment → comment), `mentions` (→ user) |
| **Knowledge** | `about` (skill/knowledge → any — what a claim/procedure concerns), `evidenced_by` (knowledge → scorecard/run/comment/agent_session — the evidence trail) |
| **Integration** | `triggers` (repository → harness), `connects_repo` (workspace → repository), `pins_image` (harness → image), `runs_image` (case/run → image), `exports_to` / `pulls_from` (harness → trace_source), `uses_secret` (any → secret), `uses_browser_profile` |
| **Classification** | `tagged_with` (any → tag) |

`uses_secret` deserves note: it turns the existing secret-usage feature into a first-class graph query ("what
references this secret"), and `pins_image` / `runs_image` do the same for image provenance — showing the payoff of a
unified graph over point features.

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

A **`KnowledgeEntryRecord`** ([knowledge-entry.ts](../../packages/contracts/src/records/knowledge-entry.ts)) is the
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

### Skills join the graph — staleness becomes a query

A **Skill** ([skill.ts](../../packages/contracts/src/records/skill.ts)) is the task-oriented complement: "how do I do
this" (a procedure bundle) vs a knowledge entry's "what is true / why we decided" (a claim). Skills decay differently —
the harnesses/datasets they document keep versioning forward, so a skill is *inherently* a legacy risk. Two additive
fields close this: `refs: NodeRef[]` — the version-PINNED entities the skill documents (authoring surface + agent both
maintain it) — and `verifiedAt`. The skill harvester projects `refs` into `skill -[about]-> harness:web@2.1.0` edges,
and then the graph's existing design pays out:

> **a skill is stale ⟺ an `about` target has an incoming `succeeds` edge** (a newer version exists)

No new staleness machinery — version-pinned node ids + `succeeds` lineage were already there; connecting `refs` turns
them into a staleness detector. Surfaced at consumption time: the skill listing carries a freshness state
(fresh / superseded-refs / unverified), and a `use_skill` result opens with a staleness banner ("references
harness@2.1.0; latest is 2.3.0 — verify before trusting"), so the agent uses an old procedure *knowing* it is old.
Skill selection reuses the same edges: skills `about`-adjacent to the task's anchors (the conversation's
`AgentReference`s, the scorecard under discussion) rank up in the listing — task-appropriate selection from structural
adjacency, no embeddings.

### Consumption converges on `assembleContext`

The point of the layer is context assembly for agents — everdict's own agent, spawned teammates/subagents, and
developers' Claude Code sessions via the plugin (MCP `get_task_context`). One service feeds all three:

```
assembleContext(anchors: NodeRef[]) →
  1. structural facts:  relatedFacts(anchors)                     (existing)
  2. knowledge:         entries `about` the anchors               (active first, verifiedAt-ranked)
  3. skill candidates:  skills `about` the anchors                (with staleness state)
  4. discussion trail:  comments `discusses`-ing the anchors      (existing edges)
```

This is the substance of "knowledge migration into everdict": the moment a developer's Claude Code pulls task context
from the workspace graph instead of a local CLAUDE.md, the workspace — not the individual — owns the knowledge.

### The accumulation loop

The three origins already cover how the layer fills: **harvest** (structural facts accrue for free; the skill/knowledge
harvesters project `refs`), **authored** (`create_knowledge` / `update_skill` via MCP + the in-product agent, whose
system prompt already directs it to record durable observations — promoted from `annotate` to entries; after a task
that used a skill, the agent proposes a revision when the procedure and reality diverged — HITL via the existing edit
path), and **extraction** (next: when a comment thread / agent session closes, an extraction agent proposes entry
candidates, confidence < 1, promoted to authored on approval). The staleness query feeds notifications ("3 skills
reference superseded versions"), so the improvement trigger is the graph's state, not someone's memory.

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
   `skill` / `knowledge_entry` (projecting `refs` → `about`, `evidence` → `evidenced_by`). Remaining (low-fan-in
   leaves): `view` / `browser_profile` / `trace_source` / `agent_session`. Idempotent, versioned by `extractor`.
3. **Contribution & extraction** — ✅ the AUTHORED write path (`annotate` / `relate`, origin `authored`): a user or
   agent contributes knowledge from Claude Code via the everdict MCP plugin, AND ✅ the **in-product conversational
   agent** (`apps/agent`) drives the same path — the `annotate_knowledge` / `relate_knowledge` tools are in its default
   tool surface (HITL-gated writes; the knowledge reads `get_knowledge_graph` / `knowledge_related` / `knowledge_subgraph`
   / `knowledge_notes` are read-only), and its system prompt directs it to consult the graph and record durable,
   evidence-backed observations as it works, so the workspace's institutional knowledge accumulates from in-product use
   too. With the knowledge layer, the prompt now steers the full loop: `get_task_context` opens an entity-anchored
   task, durable conclusions are recorded as knowledge ENTRIES (`create_knowledge_entry`, annotate demoted to margin
   notes), and freshness is maintained in-band (`verify_skill` / `verify_knowledge_entry` when a stale-flagged item
   still holds; a proposed revision when it drifted). An authored note is a mention resolved to its node (read back via `GET /knowledge/annotations`); an authored
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
   facade. The `KnowledgeStore` is `InMemory`/`Pg` by `DATABASE_URL`; `reindex` is a pull harvest of the record stores
   (scorecards/runs/schedules) AND the registries (dataset/judge/runtime/model/rubric/harness/agent, at each entity's
   latest version) — so a reindex materialises every eval-config node, not just the record nodes. Write-path
   ingest-on-write (keeping the graph current without a manual reindex) is the follow-up.
6. **Rendering** — like digo, flat, ranked fact lists powering resource "related" panels, impact analysis, and the
   agent's context first — not a graph visualization. Plus ingest-on-write hooks so the graph stays current without a
   manual reindex.
7. **Knowledge layer (v1)** — §The knowledge layer: the `knowledge` node type + `about`/`evidenced_by` predicates,
   `KnowledgeEntryRecord` (store + CRUD + MCP parity + harvester), `SkillRecord.refs`/`verifiedAt` + the skill
   harvester, the staleness query surfaced in the skill listing / `use_skill`, and `assembleContext` +
   MCP `get_task_context`. Next: extraction-based entry proposals from closed comment threads / agent sessions,
   staleness notifications, and a web Knowledge surface.

## References

- Reference system: `workspaces/digo-data` — `platform/digo_data/core/travel_knowledge/contracts/{mention_v1,edge_mention_v1}.py`
  and the `digo-travel-knowledge` skill.
- Existing proto-mention: `AgentReference` / `AgentMessageRecord.references[]` in
  [`packages/contracts/src/records/agent-session.ts`](../../packages/contracts/src/records/agent-session.ts).
