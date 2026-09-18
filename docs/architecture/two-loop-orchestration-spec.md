---
kind: spec
title: "Two loops — an orchestrator above code, work agents inside repositories, and the seams between them"
status: proposed
updated: 2026-09-18
anchors: [packages/contracts/src/records/change-campaign.ts, packages/contracts/src/records/delegation-brief.ts, packages/contracts/src/records/delegation-session.ts, packages/contracts/src/records/agent-task.ts, packages/domain/src/delegation/review-report.ts, packages/domain/src/evolution/round-brief.ts, packages/application-control/src/evolution/change-campaign-service.ts, packages/application-control/src/session/sandbox-session-service.ts, apps/agent/src/agent-mailbox.ts, plugin/hooks/session-start.mjs, plugin/hooks/capture-guard.mjs]
---
# Two loops — an orchestrator above code, work agents inside repositories, and the seams between them

> **What this specifies.** Everdict runs an agentic loop one level above code work: intent, plan, decision,
> verdict. That loop is driven by a session talking to a person, and the work it decides on is performed by
> *other* agents, in separated repo-specialised places, many of them, across runtimes. This document specifies
> the two loops, the seams where messages and interventions cross between them mid-turn, what the
> orchestrator's context is assembled from, and which existing entity carries each stage of the lifecycle.
> Proposed 2026-09-18.

## 0. Why this is a spec, and how it is kept

The pipeline is the product here, so the design record precedes the code and is updated as the loops change.
A `spec` in this repository owes two things a wiki page does not (`document-kinds.md`): it names the source it
specifies in `anchors:`, so drift is loud — `check-docs.mjs` refuses an anchor that stopped existing — and its
sections gain `Landed` one at a time rather than the whole document flipping to accepted. Section status is
tracked in §9.

⚠️ The process records are NOT here. The requests, the plans, the verdicts and the lessons live in Everdict
(`sdlc-out-of-the-repository.md`, `development-system-of-record.md`); this repository keeps the product and its
design records. This document is the architecture of the loops; DEFAUL-46 is the request for it.

**Counterexample this section owes:** delete an `anchors:` entry's file and `pnpm docs-check` must go red.

## 1. The two loops

    ORCHESTRATOR LOOP                          WORK LOOP
    ─────────────────                          ─────────
    who    a Claude/Codex session talking      a Claude Code / Codex inside a container with ONE
           to a person, schooled in the        repository cloned in
           methodology seed
    where  the person's machine (plugin) or    a sandbox on a runtime the workspace placed it on;
           apps/agent                          N of them, many runtimes
    reads  Everdict — the request, its         THAT repository's own harness: AGENTS.md / CLAUDE.md,
           lineage, what the workspace knows    .claude/skills, .claude/rules, hooks, docs
    does   intent · plan · criteria ·          the change: edits, tests, gates
           steering · judgement · records
    may    write the record, judge a round     nothing in Everdict. It has no tool surface and no
    not    — it never edits the repository      credential here, so it cannot close its own issue or
           under test directly                  settle its own campaign

The asymmetry is deliberate and already written down: *"a delegate that could close its own issue or settle
its own campaign would be grading its own exam"* (`plugin/commands/delegate.md` §8). It is what makes an
independent verification later mean anything, and it is why `ChangeJudgement` records `by` — *"a
self-judgement recorded AS a self-judgement"* (`change-campaign.ts`).

**Counterexample this section owes:** a work agent that can call any Everdict mutation for the workspace that
placed it.

## 2. The lifecycle — which entity carries each stage, and which call moves it

| # | stage | entity | the call that moves it |
|---|---|---|---|
| 1 | the request | Issue | `create_issue` (sub-issues: one per thing asked for) |
| 2 | what done means, **before the work** | `ChangeCriterion.judges` — a required discriminated union, `requirement{issueId}` or `quality` | `open_change_campaign` (the list is immutable once open) |
| 3 | the attempt's belief | `ChangeRound.hypothesis` | `log_change_round` |
| 4 | the handoff | `DelegationBrief` — `goal` · `context` · typed `references` (each with `note`: why THIS) · `constraints` · `doneWhen[{id, statement}]` | `create_sandbox` |
| 5 | steering, mid-flight | `DelegateDeliveryMode` — `message` · `task` · `interrupt` | `submit_sandbox_task` · `interrupt_sandbox_task` |
| 6 | what it is right now | `DelegateState` — 8-arm discriminated union | `get_sandbox` (`live.delegate`) |
| 7 | what it achieved | `DelegateReport` — `answers` · `changes` · `gateRuns` · `learned` · `blockers` · `questions` | the delegate writes it; it arrives on `get_sandbox` |
| 8 | is the report answerable | `reviewDelegateReport` / `tallyDelegateReport` | domain, called by the supervisor's path |
| 9 | the verdict | `ChangeJudgement.answers` — per criterion, `met`/`not_met`/`not_run` | `log_change_round` (outcome is DERIVED, never sent) |
| 10 | what it taught | knowledge `finding` / `decision` | `create_knowledge_entry` |
| 11 | how much of the request settled | `RequirementRollup` · `UnsettledRequirement` · `close_change_campaign` `landed`/`remaining` | `close_change_campaign` |

Stage 4 is derived, not typed by hand, for the evolution grade: `deriveRoundBrief`
(`packages/domain/src/evolution/round-brief.ts`) builds the brief from the frozen frame and the last round's
evidence, because *"a skill is advice, and advice at the seam where the next effect begins is the annotation
failure rule `protocol` is about."*

**Counterexample this section owes:** a stage with no entity and no call. If a reader cannot answer "which
record holds this and which call writes it", the row is prose.

## 3. The seams — how a message enters mid-turn

The only axis that matters to a work agent is what a message does to its **current turn**
(`delegation-session.ts`):

    message     lands in the mailbox and waits to be read. Starts no turn, disturbs none.
    task        work to do. Starts a turn if idle; mid-turn it is delivered AT THE NEXT BOUNDARY —
                so a busy delegate is a reason to pick a moment, not a reason to refuse (it used to 409).
    interrupt   stop and handle this. The turn is aborted FIRST.

⚠️ `interrupt` aborts a **turn, not a relationship**: the container, the working directory and the
conversation survive and the delegate takes the next message immediately. Before this vocabulary existed the
only way to stop a delegate going the wrong way was to close the session, which killed every uncommitted
change — so the cost of being wrong about "this is going badly" was the whole session, and waiting was
rational.

**The reverse direction is deliberately absent.** A work agent cannot knock mid-turn; it raises a decision by
ending its turn with `questions[]`, and that settles it `awaiting` rather than `completed`. The reason is
stated at scale: *"a supervisor watching twenty delegates must not open twenty reports to find the three
waiting on it. 'Done' and 'stuck on you' are opposite calls to action."* `questions[].why` is required, and
`options[]` is borrowed from codex's `request_user_input` — a question narrowed to two candidates is cheaper
to answer than an open one.

**Counterexample this section owes:** a `task` delivered to a busy delegate that either derails its turn or is
refused; and a delegate with questions that reads as `completed`.

## 4. The orchestrator's context pipeline

    checkout ──(1)── plugin SessionStart ──(2)── resolve hints to anchors ──(3)── assembly ──(4)── citation

1. **No credential, no network call.** `plugin/hooks/session-start.mjs` resolves the checkout to a workspace
   and repository and then *tells the session which Everdict reads to run*. The bundled MCP server holds the
   credential and the session's own tool call presents it — so a machine with no Everdict configured
   **degrades to a sentence, never to a failed request**. This is what "the plugin induces the loop" means:
   instruction, not fetch.
2. **A workspace is never guessed** — a default would write one team's work into another's trust zone. And the
   branch is a **hint, not an anchor**: a pin's key for an issue is the record id, so an identifier must be
   resolved before it can be asked with.
3. **Assembly** is `get_task_context`, and it answers only about entities the caller NAMES.
4. **Citation** is `record_retrieval_use`: which of the returned entries the work actually used.

Step 4 is the pipeline's own measurement and it currently reads zero — a session was served 13 entries and
used none. Step 3 is why: a session at its start does not yet know which entities it will touch, so
anchor-only retrieval cannot be asked the question the orchestrator actually has. This is specified as new
work in §7.

**Counterexample this section owes:** a session with no Everdict reachable that fails instead of degrading;
and an assembly whose citation rate cannot be read back.

## 5. The verdict vocabulary is not new, and must not become new

Everything about "what a piece of work achieved" is already one vocabulary in
`packages/contracts/src/records/change-campaign.ts`, and `DelegateReportSchema` reuses it by explicit
decision: *"⚠️ THE VOCABULARY HERE IS DELIBERATELY NOT NEW. **A report is a PROPOSED change round** — the same
`ChangeSetEntry`, the same `GateRun`, the same `ChangeJudgementAnswer`."*

- `CriterionAnswer` = `met | not_met | not_run` — the third value exists; `not_run` is not `met`.
- `UnmetReason` is a **closed** list so it can be counted: `attempted_and_failed` (the only one meaning "redo
  it") · `needs_information` · `needs_environment` · `blocked_elsewhere` · `descoped`.
- `ChangeJudgementAnswer` is a discriminated union on `answer`, so *"an unmet criterion WITHOUT a reason is
  unrepresentable rather than merely discouraged"*.
- `GateRun.metrics` has `min(1)`: *"a gate run that reports no number is a sentence with an exit code
  attached."*
- `gateRunIds` is required for an `observed` answer: *"an observation that names no measurement is an
  assertion wearing the other word."*
- Rounds are **append-only** — a rejected attempt is a round, not a deletion.

**Counterexample this section owes:** a second spelling of `not_met` anywhere in the orchestration path.

## 6. The measured asymmetry — each lane has what the other lacks

| | **change** grade (subject: code) | **evolution** grade (subject: harness/agent) |
|---|---|---|
| in use, 2026-09-18 | **9 campaigns · 9 rounds · adopted 5 / rejected 4 · 31 gate runs** | **0 campaigns** |
| delegation edge | **none** — zero delegation references in `change-campaign-service.ts` | a round carries `delegationRunId`; refused when the frame budgets the delegation |
| brief derived by the platform | — | `deriveRoundBrief` from the frozen frame + last round's evidence |
| anti-leak discipline | — | three exclusions by construction: no held-out ids, **no scores**, no judge rationale |
| answer guards | `assertAnswersCoverCriteria` · `assertObservationsMeasured` · `assertCommitsUnclaimed` | its own frame/reservation gate |

The evolution grade's exclusions are measured, not aesthetic: WikiSkill (arXiv 2608.27454) gave the same
knowledge to the proposer for **+15.0** and then also to the executing agent and it went **down 2.8**. A
delegate that can see the score optimises the score.

**So the specified shape is the union of the two columns**, not a new lane: the change grade gains the
delegation edge, and the delegate's report — already a proposed round — is consumed into `logRound` rather
than retyped by eye.

**Counterexample this section owes:** re-run these counts and find the change grade delegating, or the
evolution grade with a campaign. Either falsifies the asymmetry and this section must be rewritten.

## 7. What is NEW, and the measurement that justifies it

Only three things. Each names the measurement, because a preference is not a justification.

**N1 — a durable, ordered steering log per orchestrator↔worker edge.**
`apps/agent/src/agent-mailbox.ts` is in-memory and keyed per (workspace × session): a message not yet drained
does not survive an agent-service restart, while the teammate roster IS durable and is re-registered on boot.
So the roster survives and the instruction does not. A loop holding one objective for hours cannot have its
central channel be the volatile part. *Not solved by making the orchestrator re-send: a channel whose
correctness depends on the caller remembering what it already said is an annotation, not a protocol.*

**N2 — a lineage read that walks, with a bounded projection.**
Measured: `get_task_context` over ONE anchor and 20 entries returned 76,617 characters and **exceeded the tool
output limit**; `list_change_campaigns` over 9 campaigns returned 85,793 characters and did the same. Both are
the reads that answer "how did this come to be, and why was that rejected". `list_issues` already carries the
whole lesson — summary rows with detail behind `get_issue`, a cursor bound to its `order`, `linkType`+`linkId`,
and `q` for when you know the name and not the id — and three sibling reads have none of it. A lineage
question is a **graph walk with a depth**; a cursor over full bodies does not answer it.

**N3 — the report→round consumption.**
`reviewDelegateReport` and `tallyDelegateReport` exist with tests, and `DelegateReport` already speaks the
round's vocabulary, and `logRound` exists — and nothing calls the third with the first. This is the smallest
of the three and the one that closes the loop.

**Counterexample each owes:** N1 — a steering message survives a restart before it is drained, in order.
N2 — one call returns an issue's lineage several steps back without spilling to a file. N3 — a delegated round
whose judgement cites the worker's answers by criterion id and comes back `rejected`.

## 8. What this specifies AGAINST

- **A new orchestration domain.** The objective is a campaign, the step is a round, the isolated place is a
  delegate session, placement is `RuntimeSpec`/backends/topology. Inventing a fourth noun means two of
  everything at the seam where a supervisor decides whether to accept work.
- **The task ledger as the delegation substrate.** `agent-task.ts` has no reference vocabulary, no criteria,
  a claimer-declared `completed`, an explicitly informational `blockedBy`, and a `list_tasks` filterable only
  by `status` — while its own tool description recommends it for delegating to many agents. It is either
  re-founded or it stops being the recommended path (DEFAUL-40); it is not the home of stage 4.
- **A second tracker, a parallel knowledge domain, or an external tracker mirrored** — rejected with reasons
  in `development-system-of-record.md`.
- **The methodology seed before the invariants.** *"A seed without the plugin's gates is guidance, and
  guidance is what drifted here."*

**Counterexample this section owes:** an orchestration path that works only by adding a noun this section
refuses.

## 9. Section status

    §0 conventions and upkeep            proposed
    §1 the two loops                     proposed
    §2 the lifecycle table               proposed
    §3 the seams                         proposed
    §4 the context pipeline              proposed
    §5 the verdict vocabulary            proposed
    §6 the measured asymmetry            proposed
    §7 what is new                       proposed
    §8 what this refuses                 proposed

A section becomes `Landed` when its counterexample has been seen RED for the stated reason and the change that
makes it green is in the tree. Until then the whole document is `status: proposed`, and the numbers in §6 and
§7 carry the date they were measured on so a later reader can tell a stale count from a current one.

**Counterexample this section owes:** a section marked `Landed` whose counterexample was never seen
red for the stated reason. The status column is a claim like any other, and a ledger that cannot be
wrong is decoration — which is the failure this repository already refuses in its gates.
