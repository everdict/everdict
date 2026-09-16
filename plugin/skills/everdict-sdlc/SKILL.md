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
| **campaign** | the change made under that request, and how it was judged | `list_campaigns` · `open_campaign` (evaluated grade) |
| **knowledge** | what the work taught, as a durable claim | `list_knowledge_entries` · `create_knowledge_entry` |
| **task** | work handed to a teammate or to your future self | `list_tasks` · `create_task` |

## Open the session by reading, not by typing

Before touching code: `list_knowledge_entries` and `list_issues`. A convention already decided, a finding
that already names this trap, an open request that already describes this work — reading them is cheaper
than rediscovering them, and rediscovering them is what an unrecorded team does forever.

## You are the judge of your own gate — say so in a shape that can be answered

The platform does not run this repository's checks, does not know which of them constitute verification here,
and cannot tell a known flake from a real failure. **You judge.** What Everdict holds is the judgement's
shape, so state it in one:

1. **Declare the criteria when you open the work**, not after it. A criterion assembled from whatever
   happened to pass is a description of the outcome, not a gate.
2. **Answer every one** at the end — `met` · `not met` · `not run`. **`not run` is never `met`**: a check you
   could not reach is an escalation, not a silence.
3. **Mark how you know.** *Observed* = a command ran, and you can name it with its exit code. *Asserted* =
   you read the code and concluded. Both are legitimate; a reader who cannot tell them apart can defend
   neither.
4. **An empty criteria list is not a pass.** A change that verifies nothing says that.
5. You judge; you do not authorize. Adoption, release and regression watching stay with the platform, and
   your judgement is what they will later confirm or contradict.

## Close the session by recording

Write one entry per durable claim, not one per session:

- **`decision`** — what was chosen, **and what it was chosen against**. A decision without its rejected
  alternative cannot be revisited, only re-argued.
- **`finding`** — a defect's cause, a trap, a measurement. Name how it was detected, so the next person can
  detect it too.
- **`convention`** — how this service does a thing from now on.
- **`context`** — background a newcomer needs, including a declared refusal ("no knowledge this time,
  because …" is itself a `context` entry).

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
