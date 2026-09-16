---
description: Record what this session learned in Everdict — the decisions, findings and conventions, linked to the request that caused them.
argument-hint: "[what to record, if you want to narrow it]"
---

Write this session's durable claims into Everdict. Narrowing (if any): `$ARGUMENTS`.

## 1. Decide what is actually durable

Re-read what this session did and separate:

- **claims that outlive it** — a cause, a trap, a decision and its rejected alternative, a convention;
- **the diary** — what you tried, in what order. Git and the transcript already hold that; it is not knowledge.

If nothing durable happened, say so and record THAT as a `context` entry naming the reason. A refusal
someone can read is a decision; silence is not.

## 2. Write one entry per claim

`create_knowledge_entry` for each, with:

- `kind`: `decision` (include what it was chosen against) · `finding` (include how it was detected) ·
  `convention` · `context`
- `title`: the claim itself, in one line — not a topic
- `body`: the mechanism, the evidence, the caveats
- `refs`: the issue and the repository (`{type:"issue", key}`, `{type:"repository", key:"owner/name"}`)
- `evidence`: what proves it — a scorecard, a run, a comment
- `visibility: "workspace"` unless the user wants a draft

## 3. Judge the criteria you declared

Answer every criterion from the issue — `met` · `not met` · `not run` — and for each say how you know:
*observed* (name the command and its exit code) or *asserted* (you read the code and concluded). Post it as
a comment on the issue so the judgement is attributable and frozen next to the request it answers.

`not run` is never `met`, and an empty criteria list is not a pass. If the gates were red and you are
shipping anyway, that is a judgement too — write it as one, with the reason.

## 4. Close the loop on the request

`update_issue` or `create_comment` on the issue: what landed, the commit, and what is still open.
`set_issue_status status:"done"` only with the evidence it requires — otherwise leave it `in_review` and say why.

## 5. Report

List what you wrote and where, so the user can follow the lineage from the request.
