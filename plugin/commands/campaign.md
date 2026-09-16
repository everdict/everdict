---
description: Open the request and the campaign this work belongs to, so what you are about to change has a lineage back to why.
argument-hint: "[what you are about to change]"
---

Put the work about to happen on the record. What the user described: `$ARGUMENTS`.

## 1. Find out whether it already exists

`list_issues` — the request may be filed already; work under it rather than opening a second one.
`list_knowledge_entries` — a decision or finding may already govern what you are about to change.

## 2. The request

If nothing covers it, `create_issue`: the problem and why it is worth work, not the fix you have in mind.
Set `status` to `in_progress` when you start, and `projectId` if the workspace groups work that way.

## 3. The campaign

An **evaluated** change — one with a dataset, scenarios and a held-out gate — opens a campaign with
`open_campaign { issue_id, frame }`; the frame is frozen and the gate decides what may be adopted
(skill `everdict` covers the frame's fields).

An ordinary code change has no exam yet: the `change` grade that carries it is specified in
`docs/architecture/change-campaign-spec.md` and is not built. Until it is, **the issue is the hub**: work
under it, and make every knowledge entry and every commit name it.

## 4. Say what you did

Report the issue's identifier and what it now records, so the user can see where the work will land.
