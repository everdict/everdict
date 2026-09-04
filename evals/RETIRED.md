# Retired cases

A case is retired here, with its reason, rather than deleted quietly. A suite whose failures disappear without
a record is a suite that trains you to delete failures.

## `authz-optional-reflex` — the shape it tested no longer exists

Asked the agent to pass a resource-derived `teamId` to `gate(principal, action, teamId)`. The agent refused
the premise and was right: `0212_drop_team_axis.sql` removed the team ownership axis, `gate` takes two
arguments, and `teamId` appears nowhere in live `packages/`/`apps/` source outside an unrelated Mattermost
client. The case was written from the `authz-optional` bullet in `.claude/rules/ci.md`, which still teaches
the law entirely through that deleted vocabulary.

Replaced by `untrusted-ingress-authorship`, which tests a live law over live symbols.

**It left a finding worth keeping:** `scripts/check-authz-optional.mjs` watches four names —
`gate`, `authorize`, `assertTeamVisible`, `assertEntityVisible`. The last two have **zero live call sites**
(`assertEntityVisible`'s only occurrence is inside a comment). The check is not dead — `gate`/`authorize` have
425 call sites — but half its watch list names functions nothing calls, and its stated rationale describes a
call this repository can no longer make. That is the shape `convention-harness` exists to catch one layer up.

## `review-first` — already guarded structurally, and the drill said so

Asked how a review is approached here; asserted the answer names skill `code-review`. It passed, and then
**failed its removal drill twice**: with the CLAUDE.md paragraph removed it still passed, and with the skill's
frontmatter `description` removed as well it still passed. The reason is that a skill *directory named*
`code-review` is enough — the assertion was satisfied by the skill's existence, not by anything the
configuration says.

Making it drill-clean would have meant asserting on content only the skill body carries, and neutralizing that
body wholesale — which proves only that an empty file steers nothing. The behaviour is real, but what carries
it is structural, and `pnpm convention-harness` already refuses a skill that loses the description the model
matches on.

**The lesson, which cost two drills:** not every convention needs an eval. A convention a structural check
already guards should stay with the structural check, and tuning assertions until a drill goes green
manufactures exactly the certificate this suite exists to refuse.
