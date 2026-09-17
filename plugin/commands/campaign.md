---
description: Open the request and the campaign this work belongs to, so what you are about to change has a lineage back to why.
argument-hint: "[what you are about to change]"
---

Put the work about to happen on the record. What the user described: `$ARGUMENTS`.

## 1. Find out whether it already exists

`list_issues` — the request may be filed already; work under it rather than opening a second one.
`list_knowledge_entries` — a decision or finding may already govern what you are about to change.

## 2. The request — ONE ISSUE PER THING ASKED FOR

If nothing covers it, `create_issue`: the problem and why it is worth work, not the fix you have in mind.
Set `status` to `in_progress` when you start, and `projectId` if the workspace groups work that way.

**Count what was asked for, and split before you build.** A request that bundles several things — five
feedback reports, three acceptance bullets, a list with "and also" in it — becomes one issue per thing, as
sub-issues (`create_issue { parentId }`). This is not tidiness. A bundle can only be answered all-or-nothing,
so the parts that DID ship disappear into the single unmet verdict of the whole, and "how much of this is
done" stops being a question anyone can ask the record. `list_issues { parent }` is then the count.

Split by what the user would accept separately, not by what you would implement together. Two reports of the
same defect are ONE requirement. One report whose fix only removes the confusion — the screen now explains
why it refuses — is TWO: the explanation, and the thing they actually wanted.

## 3. The campaign

An **evaluated** change — one with a dataset, scenarios and a held-out gate — opens a campaign with
`open_campaign { issue_id, frame }`; the frame is frozen and the gate decides what may be adopted
(skill `everdict` covers the frame's fields).

An ordinary code change opens the `change` grade:
`open_change_campaign { issue_id, repository, path, criteria }`
(`docs/architecture/change-campaign-spec.md`). One open campaign per issue; a successor names its
predecessor in `continues`.

## 4. Declare how it will be judged — before you start, and say what each criterion judges

Every criterion carries `judges`:

- `{ kind: "requirement", issueId }` — answers one thing that was asked for. **One per sub-issue.** These
  are what the count is over. When the request is atomic, that is the campaign's own issue.
- `{ kind: "quality" }` — judges the change itself: the repository's gates, no regression, the
  counterexample seen red. Never counted as a requirement, in either direction — it cannot pad the total,
  and an unmet request cannot hide among them.

At least one must be a requirement, or the open is refused: a campaign made only of quality gates passes
without anyone saying what was asked for.

**Scope each criterion to what THIS campaign can finish.** A criterion that spans work you cannot complete
— "all five are diagnosed", when two of them need a repro path you do not have — comes back `not_met` and
takes the whole round down with it, hiding the three that shipped. What you cannot finish is the next
round's criterion, a separate issue, or the `remaining` of a partial close. Not this round's gate.

If the change genuinely verifies nothing, declare THAT as a criterion.

## 5. Say what you did

Report the issue's identifier and what it now records, so the user can see where the work will land. If you
split the request, report the count — how many things it turned out to be asked for — because that number is
the one the user will ask about at the end.
