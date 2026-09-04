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

## `scanner-blind-to-composition-root` — recall, not steering

Asked whether `apps/*/src/**/*.ts` sweeps every TypeScript source file under the apps. The recorded lesson is
that it does **not** match a file directly under `src/`, so `main.ts`, `server.ts` and `mcp.ts` — the
composition roots where wiring lives — were invisible to a scanner's first draft, and a correctly-wired guard
was reported unwired.

The answer was substantively good and about something else: it caught the missing `.tsx` files and the config
files outside `src/`, and stated that the glob covers "every `.ts` file under each app's `src/`" — which is the
exact misconception. So the case did detect a real gap in what the agent reaches for.

Retired anyway. The lesson is a **scanner-implementation detail** that lives correctly in that scanner's own
header and in rule `ci`, where it is injected at the moment somebody edits such a file. Moving it into
`CLAUDE.md` to make the case pass would be the third such move in one session, and the first two were
disciplines (a false-green lint gate, a skipped certification) while this is a fact about one glob. An eval
that asserts a cold session recalls a technical detail is testing recall; this suite is for whether the
configuration STEERS.

The distinction is the useful part: a lesson belongs in the always-loaded layer when acting on the wrong belief
does damage before anyone reads a rule. Here the rule arrives exactly when it is needed — at the keyboard, in
the file being edited.
