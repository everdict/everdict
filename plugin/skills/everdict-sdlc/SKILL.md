---
name: everdict-sdlc
description: >-
  Use at the START and the END of any piece of work in a repository that names an Everdict
  workspace — a bug fix, a feature, a refactor, an investigation, a review. Says where the work's
  record lives: the request it serves (issue), the change made under it (campaign), the code that
  shipped, and what the work taught (knowledge entries), all reachable from the request. Use it when
  you are about to change code, when you finish, when you make a decision worth keeping, when you
  discover a trap, and when a session is refused at Stop for having recorded nothing.
---

# The work's record lives in Everdict, not in this repository

A repository holds its product: code, product documentation, and the conventions of that code. **How the
work was requested, decided, reviewed and remembered accumulates in Everdict** — because a repository of
markdown is per repository, per person, and rots where nothing owns it
(`docs/architecture/development-system-of-record.md`).

## The shape — one lineage, four nouns

    issue  ──▶  campaign  ──▶  change      the code that shipped (repo · PR · merged sha)
      ▲            │
      └────────────┴──▶  knowledge  decision · finding · convention · context

Every one of them names the **issue**, so the request is one read away from everything it caused. That is
the property to preserve; the tools are secondary.

| Noun | What it is | Tools |
|---|---|---|
| **issue** | the request — what problem, and why it is worth work | `list_issues` · `create_issue` · `update_issue` · `set_issue_status` |
| **campaign** | the change made under that request, and how it was judged | `open_change_campaign` · `log_change_round` · `close_change_campaign` (code changes) · `open_campaign` (evaluated grade) |
| **knowledge** | what the work taught, as a durable claim | `list_knowledge_entries` · `create_knowledge_entry` |
| **task** | work handed to a teammate or to your future self | `list_tasks` · `create_task` |

## Open the session by reading, not by typing

Before touching code: `list_knowledge_entries` and `list_issues`. A convention already decided, a finding
that already names this trap, an open request that already describes this work — reading them is cheaper
than rediscovering them, and rediscovering them is what an unrecorded team does forever.

**Three reads, and they answer different questions.** Reach for the one that matches what you can name:

    get_task_context { refs }   about the ENTITIES YOU NAME — the projection onto an anchor's coordinate.
                                Answers nothing when you can name nothing, which is the state you open in.
    search_files { pattern }    NEEDS NO ANCHOR. Case-insensitive over the whole workspace tree: the specs,
                                plans and wiki under `docs/`, and every knowledge entry's BODY, mirrored to
                                `knowledge/<id>.md`. This is the read for "I am about to re-derive something
                                and I do not know what it is called".
    get_issue_lineage { depth } about HOW A REQUEST CAME TO BE — its campaigns, their rounds and commits, the
                                knowledge they produced, and with `depth` the chains BACK: the campaign this
                                one continues, the claim a finding superseded.

⚠️ Searching is not a fallback for failing to anchor. A session at its start genuinely cannot name the
harness, the campaign or the case it is about to touch, and the anchor read is honest about answering
nothing then. Asking it anyway and recording an empty `used` measures the question, not the workspace.

⚠️ `truncated: true` on a search is a FLOOR, not the set — narrow the `glob` or `path` and ask again.

## One issue per thing asked for — the count is the account

A request is satisfied in pieces, and the reader's first question at the end is **"of the N things I asked
for, how many are done, and why not the rest?"** That number has to be a query, not a sentence in your
report — so it is made of records:

1. **Split the bundle before you build.** Five feedback reports, three acceptance bullets, a list with "and
   also" in it — each becomes a sub-issue (`create_issue { parentId }`). `list_issues { parent }` is then
   the count, and each piece carries its own status and its own reason for being open.
2. **Split by what the user would accept separately.** Two reports of the same defect are ONE requirement.
   One report whose fix only removes the confusion — the screen now says why it refuses — is TWO: the
   explanation you shipped, and the thing they actually wanted. Folding the second into the first is how a
   half-answer gets counted as a whole one.
3. **Each requirement gets its own criterion**, `judges: { kind: "requirement", issueId }`. Criteria about
   the work itself — the gates, no regression, the counterexample seen red — are `{ kind: "quality" }` and
   are never counted as requirements.
4. **Scope each criterion to what this round can finish.** A criterion spanning work you cannot complete
   comes back `not_met` and takes the whole round down with it, hiding everything that did ship. What you
   cannot finish belongs to the next round, to a separate issue, or to `remaining` at a partial close.
5. **Every unmet answer names WHY, from a closed list** — `attempted_and_failed` · `needs_information` ·
   `needs_environment` · `blocked_elsewhere` · `descoped`. Only the first means "do the work again"; the
   rest name something to go and get, and they are invisible if the reason is prose.

`get_change_campaign` then returns the account derived from those records: `requirements.total`,
`requirements.settled`, and each unsettled one with its blockers.

## You are the judge of your own gate — say so in a shape that can be answered

The platform does not run this repository's checks, does not know which of them constitute verification here,
and cannot tell a known flake from a real failure. **You judge.** What Everdict holds is the judgement's
shape, so state it in one:

1. **Declare the criteria when you open the work**, not after it. A criterion assembled from whatever
   happened to pass is a description of the outcome, not a gate.
2. **Answer every one** at the end — `met` · `not met` · `not run`. **`not run` is never `met`**: a check you
   could not reach is an escalation, not a silence.
3. **Mark how you know.** *Observed* = a command ran, and you can name it with its exit code — and it must
   cite a gate run carrying NUMBERS, because an observation that names no measurement is an assertion
   wearing the other word. *Asserted* = you read the code and concluded. Both are legitimate; a reader who
   cannot tell them apart can defend neither.
4. **An empty criteria list is not a pass.** A change that verifies nothing says that.
5. You judge; you do not authorize. Adoption, release and regression watching stay with the platform, and
   your judgement is what they will later confirm or contradict.

**File it with `publish_checkpoint`, `role: "executor"`** — the platform's own shape for "an actor's claim
about work it did". It enforces what you cannot enforce on yourself: every `confirmedFacts` entry needs at
least one evidence reference (`run` · `scorecard` · `commit` · `issue` · `trace` · `file`), **the call is
refused if a referenced record does not exist**, and the service — not you — stamps whether each reference
resolved. Anything you believe but cannot point at goes in `hypotheses`; claiming it as a fact is the exact
failure that contract exists to prevent. `validationPlan` says how a successor would check you;
`reproduction.command` is the way back in.

**You cannot verify yourself, and should not try.** `assertIndependentVerification` refuses a verdict from
the actor that did the work, from the same run, and from the same session. When the claim matters more than
the cost of checking it, call `request_verification` — an independent verifier reads your evidence inside an
envelope with no write capability, and a `verified` citing a reference nobody read comes back
`inconclusive` with the gap named.

## File what retrieval gave you

The assembly files what it ANSWERED by itself — its path comes back in your `get_task_context` result as
`receipt.path`. Beside it, write the half only you can know:

    record_retrieval_use  { assembly_path: "<the receipt.path you got back>",
                            used: ["<entry id>", …], outcome: "what the work did with it" }

The platform resolves every id you cite and **refuses one it cannot** — a measurement built on
unresolvable citations is wrong in a way no later reader can see. **An empty `used` is a real answer** and worth writing: it says the workspace had nothing for this work, which
is the measurement that decides whether this layer is earning its keep. A session that retrieved and then
said nothing about it **is refused at Stop** — the obligation is created by the answer, not by the question,
so a session that never asked owes nothing.

## Close the session by recording

Write one entry per durable claim, not one per session:

- **`decision`** — what was chosen, **and what it was chosen against**. A decision without its rejected
  alternative cannot be revisited, only re-argued.
- **`finding`** — a defect's cause, a trap, a measurement. Name how it was detected, so the next person can
  detect it too.
- **`convention`** — how this service does a thing from now on.
- **`context`** — background a newcomer needs, including a declared refusal ("no knowledge this time,
  because …" is itself a `context` entry).

**Name what you built on.** If an entry, a decision or a convention shaped what you did — or you are
restating it with new evidence — pin it: `refs: [{type: "knowledge", key: "<id>"}]`. Five entries that
repeat one claim without naming it look like five confirmations and are one. This edge is also the only
record that the workspace's knowledge was *used*, not merely returned.

Always set `refs` to the issue and the repository (`{type:"issue", key}` and
`{type:"repository", key:"owner/name"}`), and `evidence` to what proves it — a scorecard, a run, a comment.
`visibility: "workspace"` shares it; the default is a private draft.

## What refuses

- A session that **changed code and recorded nothing is refused once at Stop**. The break-glass is
  `EVERDICT_BREAK_GLASS='<reason>'`, and the reason is reported — a visible escape, not a silent one.
- A repository that names no workspace records nothing and is told so at session start; it is not guessed
  for. Write `.everdict/workspace` (or export `EVERDICT_WORKSPACE`) to opt it in.
- Closing an issue (`set_issue_status status:"done"`) **requires evidence** — the scorecard that proved it.
  An issue you cannot prove closed stays `in_review`, which is the honest state.

## The line to hold

Record the **claim**, not the diary. "The sheet's content pan gesture swallows a third-party wheel's scroll,
and here is how to tell" is knowledge. "Fixed the time picker" is a commit message, and git already has it.
