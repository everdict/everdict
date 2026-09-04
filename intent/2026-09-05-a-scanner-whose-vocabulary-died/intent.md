# Intent: a scanner whose vocabulary died keeps passing

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

`scripts/check-authz-optional.mjs` watches four names — `gate`, `authorize`, `assertTeamVisible`,
`assertEntityVisible` — and asks whether an optional chain appears inside their argument lists. Two of them
have **zero live call sites**: `0212_drop_team_axis.sql` removed the ownership axis they belonged to,
`gate` takes two arguments now, and `assertEntityVisible` survives only inside a comment. The check reports
`PASS … 1998 files` and half its watch list names functions nothing calls.

Its header is worse than the list. It teaches the law entirely through the deleted vocabulary —
`assertTeamVisible(deps, principal, campaign?.teamId, …)`, `issue?.teamId` handed to `gate` — so a reader who
follows it writes a call this codebase cannot compile. The same vocabulary is repeated in the
`authz-optional` bullet of `.claude/rules/ci.md`.

Nothing here could catch it. `pnpm docs-check` verifies the symbols `.claude/**` backticks against live
source; a name held in a scanner's own array is source code, not prose, and no check reads it. This was found
by accident — an eval case written from that header tested a shape the codebase does not have, and only the
agent under test refusing the premise surfaced any of it.

The class is general and worse than a dead check: a scanner with a dead watch list still runs, still passes,
still prints a file count, and still teaches a rule nobody can follow. It reads exactly like coverage.

## Proposed outcome

Every scanner states what vocabulary it watches, and every watched name has a live call site. A scanner that
watches nothing says so, so the answer is complete rather than opt-in: the question "does this scanner watch
words that still exist" has an answer for all of them, not just the ones someone remembered to annotate.

`check-authz-optional.mjs` and the rule bullet teach the law in vocabulary this codebase still has, with the
deleted axis kept as history rather than as instruction.

## Affected users and systems

Every `scripts/check-*.mjs`, a new `scripts/check-scanner-watches.mjs`, `package.json`, `ci.yml`,
`scripts/ci-local.mjs`, `.claude/rules/ci.md`.

## Constraints

- **The new check must PARSE, never import.** These are scripts, not modules: importing one runs it in
  whatever tree the checker is standing in, which rule `ci` already records the expensive way for
  `protocol-mutations`.
- Removing a dead name must not read as narrowing the law. The header says which migration removed it and
  what the live shape of the risk is now.
- A scanner that watches nothing declares it in one line. Twenty of them do; the annotation must cost a line,
  not a paragraph, or it will be skipped and the check will be complete only on paper.

## Open questions

- Should a watched name be required to be a *call site* rather than any occurrence? Call sites are what the
  scanners actually match, but distinguishing them costs a parser. Occurrence outside comments is the
  approximation, and the two dead names fail it anyway.
