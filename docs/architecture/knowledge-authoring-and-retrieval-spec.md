---
kind: spec
title: "How knowledge is written and found — three layers, a claim template, and why retrieval is the half that is missing"
status: proposed
updated: 2026-09-16
anchors: [packages/contracts/src/records/knowledge-entry.ts, packages/contracts/src/knowledge/node-type.ts, packages/application-control/src/knowledge/knowledge-service.ts, packages/application-control/src/fs/content-projection.ts, plugin/skills/everdict-sdlc/SKILL.md]
---
# How knowledge is written and found

> **What this proposes.** A written method for the knowledge a workspace accumulates — what a claim owes, how
> it changes, and what it must be pinned to so an agent inherits it — derived from the evolution literature
> this repository has already read (`docs/architecture/evolution-papers/`), and an assessment of whether the
> workspace filesystem gives an agent enough to know its context. **It does not.** The store is good; the
> retrieval is anchor-only, and a session that cannot name its anchors gets nothing.

## The three layers, and why they must not merge

WikiSkill (`evolution-papers/S00.md`) keeps three stores with different update rules, and its ablation is the
argument: giving the *proposer* the curated layer was worth **+15.0 points**, giving the *executor* the same
access was **−2.8**. LLM Wiki (`R12.md`) states the same separation as a principle — evidence, interpretation,
and the maintenance rules between them.

| Layer | In Everdict today | Update rule | Who reads it |
|---|---|---|---|
| **Evidence** | runs, scorecards, campaign rounds, comments, view captures, commits | immutable after collection | everything, through references |
| **Claims** | `KnowledgeEntryRecord` (`finding` · `decision` · `convention` · `context`) | superseded, never edited in place | a session before it works; a proposer before it proposes |
| **Procedures** | `Skill` (`skills/<id>/SKILL.md` + `files/`) | versioned; improved behind a gate | the executor, at the moment of doing |

The rule the layers buy: **a claim is a materialized view over evidence** (R12). It may be stale or wrong, so
it carries the path back to what justified it, and new evidence produces a *conditional successor* rather than
an erasure — the old claim stays historically true about its own interval.

## The claim template — what an entry owes

Every field below already exists on `KnowledgeEntryRecord`; what is proposed is the **discipline**, which is
what the plugin's `everdict-sdlc` skill and `/everdict:record` now ask for.

1. **`title` is the claim, not the topic.** "The sheet's content pan gesture swallows a third-party wheel's
   scroll" is a claim. "Bottom sheet notes" is a folder name. A reader decides relevance from the title alone,
   because that is all a listing shows (R42: a description too short to distinguish two procedures is the
   discovery failure, and discovery cost is `N × m` before anything is opened).
2. **`evidence[]` is not decoration.** A `finding` or `decision` with no evidence is at best `context`. E09:
   an inferred diagnosis "belongs in an advice field with provenance; it must not replace the recorded result".
3. **State how it was detected.** The next person must be able to re-detect it, not just believe it.
4. **A `decision` names what it was chosen against.** Without the rejected alternative a decision cannot be
   revisited, only re-argued.
5. **`refs[]` pins the entities the claim is about**, versioned where the claim is version-specific. This is
   the only thing that makes the claim findable — see *Retrieval*.
6. **Record what failed.** WikiSkill's whole contribution is that a **rejected** change still teaches, and its
   wiki is preserved whether the candidate was adopted or rolled back. A campaign round that was refused is
   knowledge; today nothing asks for it.
7. **Supersede, do not rewrite.** ACE (`E08.md`) makes the same point mechanically: its curator emits a small
   **delta**, because rewriting a context collapses it. A successor names its predecessor (`supersedes`).
8. **Repetition is not corroboration.** R12: "If five wiki pages repeat one unsupported claim, there are still
   zero independent confirmations." Two entries citing the same round are one observation, and nothing in the
   store counts that today.

## What links to what

An entry is reachable only through its pins, so the pin vocabulary is the retrieval surface. `NODE_TYPES`
gained `campaign` (2026-09-16) precisely so a claim can name the attempt that produced it:

    issue ──▶ campaign ──▶ round ──▶ change (repo · commits)
      │           │
      └───────────┴──▶ knowledge ──▶ evidence: scorecard · run · comment · view capture
                            │
                            └──▶ refs: harness · dataset · judge · runtime · repository · service

**The joins that still do not exist** (each is a retrieval hole, not a modelling preference):

- **change → knowledge.** A commit cannot be a reference; `NODE_TYPES` has `repository` but no commit or
  change set. What shipped and what it taught are linked only through the issue.
- **usefulness.** Nothing records that an entry was *returned*, let alone that it *helped*. ACE keeps
  helpful/harmful counters per bullet; SkillOS (`R24.md`) learns a curator from the usefulness of future
  work. Without this signal no curation policy here can be evaluated, only asserted.
- **a gap agenda.** `workspace-knowledge.md` says it plainly under *What is not built*: coverage is computed
  per listing and "nothing collects the gaps".

## Retrieval — the half that is missing

What exists: `KnowledgeService.assembleContext(anchors)` (MCP `get_task_context`) family-matches entries and
skills to the `NodeRef`s a task names, labels each `covers | earlier | later | general` against the anchor's
version as the as-of coordinate, ranks **relation > status > recency**, and returns at most 20 + 20. That is a
good projection, and it is the whole of retrieval. The same page states the limit: **"no embedding or text
search; a task with no anchors gets no context"**. `search_files` is a budgeted, index-free glob/content-regex
grep — recall for a string you already know, not for a question.

So an agent that opens a repository and is asked to fix a defect retrieves **nothing**, because it has no
anchors yet, which is exactly when it needs the workspace's conventions most.

### The order the literature argues for

R12's priority is explicit — one derived collection, a small claim template, a repeatable comparison, and
"add search infrastructure only if navigation measurements show that the simple collection is insufficient".
SRA-Bench (`R33.md`) is the reason to resist starting with a better index: **recall is not utility** (a
reranker that improved six models' aggregate still dropped specific benchmarks), and models show weak *need
awareness* — loading a skill on ~36.9% of tasks whether or not they were failing without one.

1. **Make anchors free.** Derive them from where the session already is: the repository (`repository` is
   already a `NODE_TYPE`), the branch's issue, the campaign, the services whose files are open. The plugin's
   session-start hook resolves the repository today and tells the session to read — it should pass that anchor
   to `get_task_context` instead of asking the model to think of it.
2. **Record the retrieval.** What was returned, what the session opened, and what the work then did. This is
   the measurement every later step needs, and it is cheap: one record per assembly.
3. **Then, and only then, measure a second retriever** — text, embedding, or a router — against the anchor
   baseline, with the outcome (not recall) as the metric, and a control arm that retrieves nothing.

### Disclosure is part of retrieval

WikiSkill's executor penalty (−2.8) and R42's cost model say the same thing from two directions: more context
is not more capability. So the answer to "what does the agent get" differs by role — a session about to change
code gets *claims* (conventions, decisions, findings about the service), an executor under evaluation gets
*procedures* only, and a proposer gets the curated layer plus the path to raw evidence. Everdict has no role
dimension on `assembleContext` today; adding one is a smaller change than an index and is likely worth more.

## Does the filesystem give an agent enough context?

| Capability | State | Evidence |
|---|---|---|
| Durable bodies, revisioned, attributed | **yes** | `RevisionedWorkspaceFs`; every write publishes an attributed revision |
| One tree per workspace, member areas isolated | **yes** | `MemberScopedWorkspaceFs`; absence is NOT FOUND, never FORBIDDEN |
| Entity content projected to files (SSOT) | **yes** | `content-projection.ts` — `knowledge/<id>.md`, `skills/<id>/SKILL.md`, save/get filesystem-first |
| Accumulating record for lenses | **yes** | `views/<id>/<capturedAt>.json`, config travels with the result |
| Cross-turn memory with an injected index | **partial** | `memory/MEMORY.md` + per-member indexes are injected by the agent host — *that host only*; a plugin session gets neither |
| Find a body by content | **weak** | index-free regex grep, budgeted, `truncated` |
| Find a claim by question | **no** | anchors only; no text or embedding search |
| Know what is NOT known | **no** | no coverage-gap agenda |
| Know whether knowledge helped | **no** | no retrieval or usefulness record |
| Role-scoped disclosure | **no** | one `assembleContext` for every caller |

**Verdict.** As a *store* the filesystem is more than adequate — it is versioned, attributed, scoped, and it
already holds the bodies. As a *retriever* it is not: an agent knows its context only when something else has
already told it which entities to ask about. The gap is not storage capacity, and adding an index first would
be optimizing the half that is not broken.

## Order of work

1. **Anchors from the session** — the plugin passes repository / issue / campaign / service anchors to
   `get_task_context` at session start, instead of naming tools for the model to remember.
2. **A retrieval record** — assembly id, anchors, what was returned, what was opened, and the work's outcome.
3. **Role-scoped disclosure** on `assembleContext` (claims vs procedures vs curated+raw).
4. **Usefulness counters** derived from (2), and a curator policy that can then be *evaluated* rather than argued.
5. **A coverage-gap agenda** — the entities a workspace works on that no active claim covers.
6. **Search, measured** — only after (2) can say whether anchors were insufficient, and judged on outcome.

## What would reopen it

- **Anchors turn out to be enough** once they are free: then steps 3–6 are optimizations and step 6 never runs.
- **A workspace whose work is not entity-shaped** — support, research, sales — has nothing to anchor on, and
  the anchor-first order is wrong for it.
- **Retrieval records prove the executor benefits** from claims (contradicting WikiSkill's −2.8 under a
  different protocol): then role-scoping is the wrong shape and the disclosure rule should be measured, not fixed.
