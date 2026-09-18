---
kind: spec
title: "Every code change is a campaign — one lineage from the request to what shipped and what it taught, enforced by the plugin"
status: accepted
updated: 2026-09-18
anchors: [packages/contracts/src/records/evolution-campaign.ts, packages/contracts/src/records/change-campaign.ts, packages/domain/src/evolution/change-campaign.ts, packages/contracts/src/knowledge/node-type.ts, packages/contracts/src/records/tracker.ts, plugin/.claude-plugin/plugin.json, plugin/hooks/hooks.json]
---
# Every code change is a campaign — one lineage from the request to what shipped and what it taught

> **Slice 4 of `docs/architecture/development-system-of-record.md`** ("the plugin loop"), with the scope the
> maintainer set on 2026-09-16: **every code change is a campaign**, and a session that records nothing is
> **refused**, not reminded. This spec states the model, what has to change to represent it, and what the
> plugin enforces. The enforcement half lands first; the record half is its own slice below.

## The gap, measured

A full coding session ran on this machine on 2026-09-16 — a defect in `digo-mobile` diagnosed, fixed,
tested and committed (`df1cd85f8`). It created **0 issues, 0 campaigns, 0 knowledge entries**. What it
learned (a bottom-sheet gesture swallows a third-party wheel's scroll; a guideline checker reports PASS when
ripgrep is absent) reached a private memory directory and a commit message. Neither is readable by anyone
else, and neither is reachable from the request that caused the work.

That is not a discipline failure. **Nothing in the plugin asks**: it ships MCP tools, one skill whose
description triggers only on evaluation, two commands, and **no hooks**. The session behaved exactly as the
plugin is built.

## Why today's campaign cannot carry it

`open_campaign` requires a frame that names an evaluated **subject** and an exam:

```ts
subject:    { type: "agent" | "harness" | "environment", id, baselineVersion }   // required
scenarios:  [{ id, heldOut }]   // minItems 1 — the exam
trialsPerCase, budget            // required
```

A bug fix in a mobile app has none of them: no agent/harness/environment subject, no scenarios, no
scorecard. Opening one anyway produces a campaign whose exam proves nothing — the state the record already
names `exam_inert`, whose own comment calls it "the thing to read first" when a campaign ends that way. A
verdict that cannot be wrong is not a verdict.

**So the word has to grow a second grade, and the existing one must not be diluted.** Making `frame`
optional would make every reader of a campaign's gate ask "is there an exam here at all", which is the
shape this repository's protocol laws name as the recurring defect: the right noun consumed as an optional
annotation.

## The model — one spine, two grades

The spine is the lineage the maintainer asked for, and it already exists in the evaluated grade:

    issue  ──▶  campaign  ──▶  change      (the code that shipped: repo, PR, merged sha)
      ▲            │
      └────────────┴──▶  knowledge  (what it taught: decision · finding · convention · context)

Every arrow is a stored reference, so the request is one read away from anything the work produced:

| Link | Today | After this spec |
|---|---|---|
| campaign → issue | `EvolutionCampaignRecord.issueId` — "the intent hub" | unchanged, both grades |
| shipped code → issue | `CampaignAdoptionProof.issueId` + `AdoptionCodeDebt{repo, prNumber, mergedSha}` | unchanged, both grades |
| knowledge → issue | `NodeRef{type:"issue"}` | unchanged |
| **knowledge → campaign** | **impossible** — `NODE_TYPES` has no `campaign` | `NODE_TYPES += "campaign"` |

`NODE_TYPES` is a closed, PR-gated vocabulary that "only GROWS" by its own governance note, which is exactly
the change this needs.

### Grade `evaluated` — unchanged

Today's evolution campaign: a frozen frame, held-out scenarios, rounds judged by scorecards, adoption behind
a gate. It stays the strong form, and nothing here weakens it.

### Grade `change` — new

    subject       a SERVICE — a product service (repository, optionally a path) or a harness
                  (the service reference, slice 1 of the system-of-record decision)
    verdict       the repository's own gates: its tests, types, lint and scanners, plus review
                  — declared as what was run and what it answered, never inferred from a green console
    rounds        one per attempt that reached a verdict; a rejected attempt is a round, not a deletion
    close         adopted (the change landed: repo, PR, merged sha) | abandoned (with the reason)
    owes          knowledge at close — see below

A change campaign is opened from an issue and closed by what landed. It carries no exam, and it must never
claim one: a `change` campaign has no held-out block, no significance arithmetic and no adoption proof over
scorecards. Its authority is the repository's gates, which is weaker than a held-out exam and is **stated**
rather than implied.

### A campaign spans services, and a service's change is many commits

The unit a request causes is not one commit in one repository. Fixing "the time picker cannot be set" touched
one repository; shipping a feature routinely moves an API, a BFF and a mobile app, each over several commits,
and the request is satisfied only when all of them are in. **Today that is not representable**: a round names
one `candidateVersion`, and an adoption carries `AdoptionCodeDebt { repo, prNumber, sha }` — one repository,
one pull request.

A round therefore gains the change set it produced:

```ts
changes: [
  {
    service: ServiceRef,        // the product service or harness (system-of-record slice 1)
    repo: "owner/name",
    path?: "apps/api",          // the subpath inside a monorepo, when the service is one
    commits: [{ sha, message, at }],   // what actually landed, in order
    pr?: { number, url, mergedSha? },
  },
  …
]
```

Two properties this owes, both of them the reason to store it rather than to recompute it from git:

- **A commit belongs to exactly one round.** A sha that appears under two rounds makes "what did this attempt
  change" unanswerable, and the second answer is the one that silently wins today.
- **A change set is closed at the round's verdict**, not left open. Commits pushed after the verdict belong to
  the NEXT round — otherwise a green verdict slowly comes to describe code it never saw, which is the
  "provenance is born at the source" law applied to a branch that kept moving.

### The verdict answers four questions, in both grades

The evaluated grade already answers them and stores each answer separately; the `change` grade answers the
same four so one reader serves both:

| Question | Evaluated grade (today) | `change` grade |
|---|---|---|
| Was it evaluated at all? | `baselineScorecardId` + `candidateScorecardId`, `comparable` | which repository gates ran, and their outcome — declared, never inferred from a green console |
| Was the experiment satisfactory? | `significantImprovements` / `significantRegressions`, non-inferiority | the gates passed, and the review disposition |
| **Did it show the ISSUE resolved?** | `verdict.response.solved[]` / `failed[]` against `frame.targets` | the request's acceptance criteria, named at open, each marked met / not met |
| Did it meet the criteria? | the frame's gate, by `gateDigest` over a frozen frame | the same digest discipline over the declared criteria |

`unmeasured { cases, of }` has no analogue to invent: a repository gate that did not run is `not run`, and
"could not find out" stays a third value rather than collapsing into pass (protocol L2).

### Lineage is a graph, and it is read from the request

The edges already exist, in three places that do not join:

- `campaign.issueId` — campaign → request
- `frame.continues` — campaign → the campaign it continues (a parent pointer: "a walk is a chain of
  campaigns, not a campaign that runs forever")
- `HarnessLineageVersion.predecessor` / `forkedFrom` — version → version, including forks

What is missing is one read that starts at the request:

    issue A
    ├── campaign 1 (evaluated)          rounds 1..n, each: hypothesis → changes[] → verdict
    │   ├── round 1  ✗ rejected         digo-api@3 commits · digo-bff@1 commit
    │   ├── round 2  ✓ adopted          digo-api@2 commits · digo-mobile@4 commits
    │   └── knowledge: decision, finding
    └── campaign 2 (continues campaign 1)
        └── round 1  ✗ abandoned        reason recorded

A **tree** by `continues`, a **graph** once forks and knowledge edges are included (an entry may govern
several services, and a later campaign may be informed by an earlier campaign's finding through
`round.informedBy`). The read returns the nodes and edges; it does not recompute them from git, because a
lineage derived from branch history is a lineage that force-push can rewrite.

### The close owes knowledge

A campaign may not close silently. Closing takes either
- at least one knowledge entry created in this campaign (`refs` naming the campaign and its issue), or
- a declared refusal: `Knowledge: none — <why>`, stored on the close.

This is the seed's idiom for the other refusals (`Design: none — …`, `Regression-test: none — …`): a refusal
is a decision someone can read, and silence is not one. "Accepted ≠ gone" (protocol L5) applied to learning:
a campaign that closes with nothing recorded has not finished, it has only stopped.

## The division of labour — the agent judges, Everdict holds the judgement

The maintainer's stance (2026-09-16): **Everdict supports the AI-SDLC method and holds evaluation and
verification tightly; the actual build is delegated to an agent running in a repository workspace** (Codex,
Claude Code, any registered profile) — and **the gate is judged by that agent**, the one that opened the work
with this plugin, not by the platform.

⚠️ **This corrects an earlier reading of "holds verification tightly" as "computes the verdict".** The
platform cannot judge a repository's gates: it does not run them, it does not know which of them constitute
verification for that service, and a red suite that is a known flake is a judgement someone has to make.
Holding verification tightly means something else, and it is the harder half — **demanding the judgement,
giving it a shape, attributing it, freezing it, and making it answerable later.**

Everdict already owns the delegation half. `create_sandbox { profile, brief, repo:{git, ref} }` boots a
profile's image with the repository cloned in; `submit_sandbox_task` sends one turn at a time;
`read_sandbox_task_trace` shows what the delegate did; `sandbox_exec` runs the repository's own checks; and
`sandbox_git_push` publishes the branch with a token minted for that one call — a guarded action that pauses
for a member. The delegation profile's own contract states the relationship: **the delegate is EMPLOYED, not
under test.**

That distinction is load-bearing here. **The change is the evaluated subject; the builder is not.** Measuring
the coding agent is a different product (agent benchmarking, which Everdict also does — as a `harness` under a
frozen frame). Confusing the two turns every ordinary bug fix into an evaluation of Claude Code.

| Concern | Owner |
|---|---|
| the request, and the shape a judgement must take | Everdict |
| the acceptance criteria, **declared before work starts** | the agent, recorded by Everdict |
| reading the repository, writing the code, running that repository's gates | the agent, in its workspace |
| **judging** whether each criterion was met | **the agent** |
| the judgement as a record — attributed, frozen, unanswerable-by-silence | Everdict |
| whether the change may be **adopted**, and what that authorizes | Everdict |
| what the work taught | the agent writes it; Everdict pins it to the campaign and the request |

### What crosses the seam, and in what shape

This is where verification is not yet tight. `delegate_work` instructs the driver to "verify the result
yourself, then land it … and report with evidence" — so today verification arrives as **prose in a report**,
and `sandbox_exec` leaves a trace nobody parses. `GatePolicy` / the release gate decision is a verdict over a
baseline↔candidate **scorecard** comparison; there is no record for "this repository's own gates ran and this
is what they said".

A `change` campaign's round therefore needs a **verdict the agent writes** — and that record already exists.
It is the ownership protocol's, and inventing a second one would have been this repository's own recurring
defect: the right noun present and a parallel annotation built beside it.

**The agent's judgement is an EXECUTOR'S CLAIM, not a verification.** `assertIndependentVerification`
(`packages/domain/src/ownership/ownership.ts`) refuses a verdict from the actor that did the work — *"a claim
wearing a second hat"* — and refuses one from the same run or the same session. Its first line is what makes
the working agent's judgement legal anyway:

```ts
if (verifier.profile.completion !== "verified_verdict") return;   // a report or a change_set claims
                                                                   // nothing about someone else's work
```

So the session that built the change publishes a **handoff checkpoint** with `role: "executor"`
(`publish_checkpoint`), and the platform already enforces the part a model cannot be trusted to enforce on
itself:

| The judgement's shape | Enforced by | Where |
|---|---|---|
| a claimed fact carries **at least one evidence reference** | the schema (`refs.min(1)`) | `confirmedFacts` |
| **a referenced record must exist** — the call is refused otherwise | the checkpoint service | `publish_checkpoint` |
| what the platform could resolve vs what it could not | stamped by the service, **never by the producer** | `CheckpointRef.resolution` = `verified` \| `unverified_external` |
| a belief with no reference is a **hypothesis**, and says so | the schema | `hypotheses` |
| how a successor would check the work | required field | `validationPlan` |
| the way back into the exact state | `reproduction.command` | — |

That is the *observed vs asserted* split this spec asked for, already built: **a fact is what you can point
at; everything else is a hypothesis, and the type refuses to let it claim otherwise.**

The `change` grade now carries these in fields, and they are enforced at the door rather than asked for:

- **criteria declared before the work**, not assembled from what happened to pass — the list is immutable
  once the campaign is open;
- **every declared criterion answered** — `met` · `not met` · `not run`, with `not run` never counting as met;
- **an empty criteria list is not a pass**;
- **every criterion says what it judges** (`judges`) and **every unmet answer says why** (`reason`) — the two
  fields below.

### A criterion says what it judges, so the request can be counted

*Maintainer, 2026-09-17, after a campaign that judged five feedback reports under one criterion.* A
campaign's criteria are two different things wearing one name: some answer a REQUEST the issue made ("the
photo opens"), others judge the WORK ("the suite is no worse"). Only the first kind can be counted against
"how much of this is done", and while the distinction lived in the reader's head, so did the count — "three
of the five shipped" was prose in a `detail` field that no query could reach.

    judges: { kind: "requirement", issueId }   // answers one thing that was asked for
          | { kind: "quality" }                // judges the change itself
          | { kind: "unclassified" }           // ⚠️ migration only — see below

`judges` is required, and a union rather than an optional `issueId`, because an optional pin makes "this
criterion answers no request" and "the author did not say" the same value — the defect the protocol laws
name. **At least one criterion must be a requirement**, or a campaign made entirely of quality gates passes
without anyone saying what was asked for and its count reads 0 of 0 forever. When the request is atomic,
that criterion names the campaign's own issue.

Requirement pins are **resolved at open** like the campaign's own `issueId`: what is stored is the id the
resolution produced, and a requirement the workspace does not have is a refusal rather than a count over
issues nobody can open.

The reading this buys is derived on every campaign read, never stored — a stored total would be a second
opinion about the same answers:

    requirements: { total, settled, unsettled: [{ issueId, criterionIds, blockers: [{criterionId, answer, reason}] }],
                    unclassifiedCriteria }

`unclassified` exists for criteria written before the distinction did (migration `0219`). It is deliberately
not a synonym for either real kind: stamping them `quality` would report an unmet REQUEST as a passed gate,
and `requirement` would invent a request nobody made. The rollup counts them apart and the campaign page says
the count is incomplete — unknown is a third value (protocol L2), not a default. The request schema rejects
it, so nothing new is born unclassified.

**Scope a criterion to what its round can finish.** The campaign that prompted this declared "all five
reports are diagnosed" as one criterion, could only diagnose three, answered `not_met`, and took the whole
round down with it — two shipped fixes recorded inside a `rejected` round, and the three that were blocked
each blocked differently with nothing saying so. What a round cannot finish belongs to the next round, to a
separate issue, or to `remaining` at a partial close. Not to this round's gate.

### An unmet answer says why, from a closed vocabulary

"Which ones failed, and why" is the half a reader acts on, and `not_met` alone collapses answers that call
for completely different next moves:

| `reason` | what it means | what it asks of the reader |
|---|---|---|
| `attempted_and_failed` | the work ran and fell short | do the work again |
| `needs_information` | a repro path, a log, the reporter's answer | go and get it |
| `needs_environment` | a device, a staging service, real hardware | go and get it |
| `blocked_elsewhere` | another team, repository or product decision | escalate |
| `descoped` | dropped from THIS campaign | nothing — but it is still not met |

Only the first means "try again". A closed list because the point is to COUNT them: free text cannot answer
"how many of our unmet criteria are waiting on something we could just go and fetch". The answer is a union
on `answer`, so an unmet criterion with no reason is unrepresentable rather than merely discouraged — and
`met` carries no reason, because a reason on a met criterion is a second verdict with no way to choose.

### Independence is available, and it is a different call

`request_verification` exists and runs a verifier **inside an evidence-only envelope — no write capability,
reads restricted to the tools that reach the cited evidence** — and it refuses a verifier that executed the
work, or one in the same run or session. Its own failure mode is closed too: *a `verified` with a reference
nobody read comes back `inconclusive` with the gap named*, because an unchecked half is a species of
could-not-tell.

So the grip is not "the platform judged". It is: the agent's claim is recorded **as a claim**, its evidence
is resolved or honestly marked unresolvable, and an independent verdict can be demanded over exactly that
evidence whenever the claim matters more than the cost of checking it.

### What must not cross

Authority — which is a different thing from judgement, and the distinction is the whole design. The agent
**judges**: it says whether the criteria were met and stands behind that. The agent does not **authorize**:
adoption stays with the platform, which is already how `sandbox_git_push` behaves (guarded, pauses for a
member) and how a campaign adoption is a spendable proof rather than a claim in a report.

The platform's later reads are what make the agent's judgement answerable: an evaluated grade's gate
arithmetic can contradict it, a regression watch can, and the next campaign that continues from this one
inherits both the claim and what happened after. **A judgement nobody can contradict later is not being held
tightly, however carefully it was recorded.**

### Why the plugin is the instrument

The record has to be captured where the work happens — inside the delegated agent's session, not in a UI the
builder never opens. That is what the session-start and Stop hooks are: **Everdict's hand inside the
builder's workspace**, injecting the service's knowledge before the work and refusing to let the session end
having recorded nothing after it.

## What the plugin enforces

Four seams, all of them in the plugin because that is where a coding session actually is:

1. **Session start** — resolve the checkout to a workspace and service; load that service's active decisions
   and conventions and the open requests against it into the session. A session that cannot resolve a
   workspace says so; it does not guess one.
2. **Before code changes** — the work belongs to an issue and a campaign. If none is open, the session opens
   them (`/everdict:campaign`), naming the issue it serves.
3. **Stop** — a session that changed code and left no **round** in Everdict **is refused once**, with the
   reason handed back to the model. The escape is a **break-glass**: a recorded reason, visible afterwards,
   never a silent skip. The loop guard is the hook's own `stop_hook_active` flag, so refusal happens once per
   session, not forever.

   ⚠️ **A ROUND, not merely a record — and the difference is what the guard got wrong first.** Until
   2026-09-18 any recording tool discharged the obligation, so one `create_issue` was enough, and the change
   grade's own tools (`open_change_campaign`, `log_change_round`, `close_change_campaign`) were not even in
   the vocabulary: a session that ran the change loop perfectly was refused for "recording nothing".

   Measured that day on this repository: a session spent hours on nine commits across five packages, filed
   five issues, closed them with resolution notes, wrote four knowledge entries — and `lint 0 · test 51/51 ·
   build 51/51`, eight scanners and thirteen neutralizations seen red all ended up in git commit bodies,
   outside Everdict, unqueryable and uncomparable to the next round. It was not a lazy session. The guard was
   asking a weaker question than the one it exists to force.

   The reason issues and knowledge cannot substitute: a person who asked for work wants **what problem · what
   method · what result · what verification**, and only a round carries the fourth. `gateRuns` with exit
   codes and metrics live there and nowhere else. So they stay necessary and stop being sufficient, and the
   refusal names `/everdict:campaign` and shows the `log_change_round` shape rather than saying
   "record something" — which is the refusal that produced the defect.
4. **After** — the commits and pull request are linked to the campaign, and the campaign's close names the
   merged sha.

### The bundled server carries the workspace, not the credential

`plugin/.mcp.json` gains `x-everdict-workspace: ${EVERDICT_WORKSPACE}` — an unset variable expands to an
empty header, which the control plane already treats as absent (`workspaceHintOf` requires a non-empty
value), so the same manifest is correct on a machine that has never heard of Everdict.

It does **not** gain an `Authorization` header. An unexpanded or empty credential is not "no credential": it
is a credential the client believes it has, and the 401 challenge that would otherwise start the browser
login becomes a failed handshake. Credentials stay on the path the guide already documents —
`claude mcp add --transport http everdict "$EVERDICT_MCP_URL" --header "Authorization: Bearer $EVERDICT_API_KEY"`
for headless, OAuth for an interactive session.

⚠️ **A hook is a client feature, and that is this design's declared limit.** A client that does not run
plugin hooks — CI, another editor, a human with a terminal — is not enforced by any of this. The record is
still correct there (the MCP surface refuses what it always refused), but it is not *forced*. Enforcement at
the seam that cannot be bypassed is the repository's own push gate, and moving it there is what
"What would reopen it" in the system-of-record decision already names.

## What refuses

| Situation | Answer |
|---|---|
| Session changed code, recorded nothing | Stop refused once, with the reason and the break-glass named |
| Session changed code, recorded but logged NO round | Stop refused once, naming the round and what it needs — issues and knowledge do not carry what was RUN |
| Break-glass used | allowed, and the reason is written to the campaign as a `context` entry |
| Workspace cannot be resolved | session told explicitly; no default workspace is assumed |
| `change` campaign closed with no knowledge and no declared refusal | close refused |
| `change` campaign presenting scorecard authority | refused — that is the `evaluated` grade |
| A commit claimed by two rounds | refused — "which attempt changed this" must have one answer |
| A change set edited after its round's verdict | refused — the verdict would come to describe code it never saw |
| A round closed with a verdict that names no acceptance criterion | refused — "it works" is not a criterion |

## Order of work

1. **Enforcement slice (now).** The plugin's four seams against the entities that exist today (issue,
   knowledge, comment), plus `NODE_TYPES += "campaign"` so the next slice has a reference to write.
2. ✅ **The `change` grade** (2026-09-17). A separate record rather than an optional frame; contracts, the
   domain's refusals, migration 0218 with in-memory and Postgres stores, the service, and both transports in
   one slice. The service reference it will eventually want (system-of-record slice 1) is approximated by
   `{repository, path?}` until that exists.
3. ✅ **The close's knowledge obligation** — the entries it produced, or `knowledgeDeclined` with the reason.
4. ✅ **The change set** — `round.changes[]` (repository · path · commits · pull request), with
   one-round-per-commit enforced at write time. Rounds are append-only, so "closed at the verdict" holds by
   construction rather than by a check.
5. ✅ **Lineage read** — `GET /issues/:id/lineage` and `get_issue_lineage`: the campaigns of BOTH grades
   opened against the request, each round with the commits it moved in each service, and the knowledge
   reachable from the issue **or from one of its campaigns** — the second edge exists only because `campaign`
   joined the reference vocabulary. Composed from the records rather than materialised (a lineage table would
   be a second authority that can disagree with them), and it names the sources it could not read, because an
   unwired collaborator must not read as a request that caused nothing.

6. ✅ **The walk** (2026-09-18, DEFAUL-47). The read answered one hop and stopped, which answers "what did
   this cause" and not "how did it come to be" — and the edges for the second question were all stored while
   nothing followed them. `assemble` now takes a **depth the caller declares** (1–5; 1 is the request's own
   records, so no existing caller moved) and walks `continues` on BOTH grades and `supersedes` on knowledge,
   so a retracted claim is reachable from the request whose work replaced it. Each item carries the hop that
   reached it, and an ancestor reached only by supersession says which entry replaced it — `reachedBy` gains a
   third way in rather than pretending an entry nobody pinned is unreachable. A depth outside the range is
   REFUSED rather than clamped. `walk` reports how the traversal ended as three counts, each a different thing
   to do about it: `truncated` (ask again with more depth), `cycles` (a defect in the records, not the
   reading) and `unresolved` (a step this deployment could not fetch — unknown, never absent). The change
   grade also starts EMITTING `continues`, which it stored from the start and never reported, so every
   partially-adopted request had an invisible successor chain. The issue screen asks for depth 3 and renders
   ancestors inset by their hop, because a capability is not built until it reaches the web.

**Still open:** the evaluated campaigns are filtered by issue in memory, because that store lists by subject —
honest and O(n), worth an indexed read when a workspace's campaign count makes it matter. And the walk does
not follow the **sub-issue** axis: `open_change_campaign` instructs splitting a bundled request into
sub-issues, so a split request's lineage still scatters into children the parent's read cannot see.

## The questions this spec opened, and how they were answered

All five were settled by the maintainer on 2026-09-17 and are now enforced rather than described. They stay
here with their answers because a reader who meets the code needs to know which of its shapes were CHOSEN.

1. **What closes a round?** → **The agent does, by logging it.** There is no merge event and no external
   trigger: the moment a round is recorded is the moment the session that produced it judged it finished.
   That is why the gate runs it judged on travel with the round rather than being collected afterwards.
2. **Where do the verdict's bytes live?** → **The numbers do; the logs do not.** `GateRun` carries the
   command, the exit code and at least one `metric` — "4027 passed, 51 of 51 tasks" rather than "the suite is
   green" — and an `observed` answer must cite one by id. A measurement can be compared to the next round and
   disagreed with; a sentence cannot. Storing the raw output was rejected as making a change campaign's
   evidence as heavy as an evaluated one's for a weaker verdict.
3. **One campaign per branch, or per issue?** → **Per issue, one OPEN at a time.** A second open one is
   refused with the id of the one in the way, and the next opens after it ends, naming it in `continues`. A
   request's attempts are a chain rather than a set nobody can order.
4. **Is one-commit-per-round scoped to the campaign or to the request?** → **To the chain**, which (3) made
   possible: the check walks `continues` backwards, so a successor cannot re-claim its predecessor's commits
   and make one sha appear under two attempts in the request's lineage. Bounded and cycle-safe — corrupt data
   must not turn a write path into a hang.
5. **Cross-service atomicity.** → **`partially_adopted` exists, and the remainder is a successor's work.** It
   requires BOTH `landed` and `remaining`: one of them empty is an adoption or an abandonment wearing the
   middle word, and a full adoption carrying either is a second ending.

**What stays open:** a `change` campaign still cannot carry `continues` *forks* — the chain is linear, where
the evaluated grade's `continues` admits a tree — and evaluated campaigns are filtered by issue in memory,
because that store lists by subject.

## What would reopen it

- **Sessions that legitimately change no code** (reviews, investigations) being refused at Stop: then the
  trigger is wrong, not the policy — refusal keys on a code change, and an investigation that produced a
  finding has already recorded one.
- **A team whose changes are not evaluable at all** — no tests, no gates. Then a `change` campaign's verdict
  field is empty everywhere and the grade is bookkeeping; the honest answer is to say so rather than to
  record a verdict nobody produced.
