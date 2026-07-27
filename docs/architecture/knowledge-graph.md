# Workspace Knowledge Graph

> **SSOT** for everdict's knowledge system. Status: **steps 1–3 landed** — the contract spine + this doc; the first
> harvester (`ScorecardRecord`) + the `KnowledgeStore` (in-memory + Postgres); and the multi-hop query engine. More
> harvesters, text extraction + resolution, and the API/rendering surface are next (see §Roadmap).

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

`NODE_TYPES` ([node-type.ts](../../packages/contracts/src/knowledge/node-type.ts)) — 26 types by axis. The vocabulary
is **closed**: inventing a type is a code change, never a runtime value. Because the spine is type-agnostic, adding one
is a one-line enum extension plus a harvester — the same cheap axis digo grew 14 → 17 on.

| Axis | Node types |
| --- | --- |
| **Actors (WHO)** | `workspace`, `user` |
| **Under test (versioned)** | `harness`, `dataset`, `case`, `judge`, `rubric`, `model`, `agent`, `capability` |
| **Execution infra (WHERE)** | `runtime`, `runner`, `image` |
| **Execution & outcomes (WHEN)** | `run`, `scorecard`, `schedule` |
| **Analysis** | `tag`, `metric`, `view` |
| **Knowledge & comms** | `skill`, `comment`, `agent_session` |
| **Integration & external** | `repository`, `trace_source`, `secret`, `browser_profile` |

Deliberately **not** nodes: `member` (an edge, `member_of`), `notification` / `budget` / `usage` (projections /
metering, downstream of the graph), `workspace_settings` (a source whose sub-objects become edges).

## Predicate vocabulary (closed, PR-gated)

`PREDICATES` ([predicate.ts](../../packages/contracts/src/knowledge/predicate.ts)) — 33 predicates by axis. **Direction
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
| **Integration** | `triggers` (repository → harness), `connects_repo` (workspace → repository), `pins_image` (harness → image), `runs_image` (case/run → image), `exports_to` / `pulls_from` (harness → trace_source), `uses_secret` (any → secret), `uses_browser_profile` |
| **Classification** | `tagged_with` (any → tag) |

`uses_secret` deserves note: it turns the existing secret-usage feature into a first-class graph query ("what
references this secret"), and `pins_image` / `runs_image` do the same for image provenance — showing the payoff of a
unified graph over point features.

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
   ✅ `ScorecardRecord` (the densest FK hub). Next: `harness` / `dataset` / `judge` / `run` / `schedule` / `comment` /
   `membership` — each materialises its own node + edges. Idempotent, re-runnable, versioned by `extractor`.
3. **Extractors** — text adapters for `comment` / `agent_message` / `pr_comment` (@-mention regex first, agent
   extraction later), plus a resolver (surface `nodeRef` → `resolvedNodeId`).
4. ✅ **Multi-hop query engine** — `KnowledgeQueryService` (`application-control`): `subgraph` (BFS by depth /
   direction / predicate / node-type over the store's single-hop primitives) + `relatedFacts` (ranked 1-hop flat facts
   for rendering, the `mentionGrounding` / `cityKnowledge` analog). A Pg-native recursive-CTE fast path can slot in
   behind the same surface later.
5. **API + rendering** — the HTTP/MCP surface (graph queries, per-record ingest on write) + rendering: like digo, flat,
   ranked fact lists powering resource "related" panels, impact analysis, and the agent's context first — not a graph
   visualization.

## References

- Reference system: `workspaces/digo-data` — `platform/digo_data/core/travel_knowledge/contracts/{mention_v1,edge_mention_v1}.py`
  and the `digo-travel-knowledge` skill.
- Existing proto-mention: `AgentReference` / `AgentMessageRecord.references[]` in
  [`packages/contracts/src/records/agent-session.ts`](../../packages/contracts/src/records/agent-session.ts).
