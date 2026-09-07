# Plan: agent-configuration evals

From: intent.md @ eee56f50075d2f9f4798d7ceeadb930f8d6486be

## Files that change

- `evals/README.md` (new) — what a case is, how to add one, and the removal drill.
- `evals/cases/*.json` (new, 7) — one per recorded failure this repository already documents.
- `evals/run.mjs` (new) — the runner. Plain Node, no deps, `claude -p … --output-format json`.
- `.github/workflows/agent-evals.yml` (new) — path-filtered on `CLAUDE.md`/`.claude/**`/`evals/**`, plus a
  nightly cron and `workflow_dispatch`.
- `package.json` — `agent-evals` script.
- `.gitignore` — `evals/.results/`.
- `.claude/rules/ci.md` — record what the suite is, and why it is NOT in `ci:local`.

## Order of work

1. `evals/run.mjs` and one case, driven end to end against the real CLI, before any more cases exist. The
   runner is the risk; seven cases against a runner that does not work is seven wasted calls.
2. The remaining six cases, each citing the incident it comes from.
3. `--drill <id>`: neutralize a case's declared `subject` in the working tree, re-run that case, require it to
   go RED, restore in a `finally`. This is the removal drill for the configuration layer, and unlike
   `protocol-mutations` it costs one agent call rather than a build and a suite.
4. Wire the workflow, the script and the rule.
5. Run the whole suite, and run the drill on at least one case.

## Risks

- **The assertions are the whole product, and a weak assertion is worse than no case** — it certifies a
  convention nobody checked. Every case asserts on substance the agent must NAME (a command, a refusal, a
  file it must read first), never on phrasing. `mustNotMatch` carries the failure that actually happened.
- **Flakiness reads as regression.** Model output varies; an assertion that depends on wording will fail for
  reasons that have nothing to do with the configuration. Mitigated by asserting on named artifacts, and by
  step 3 — a case that cannot be made to fail by deleting its subject is not measuring its subject, and the
  drill is what surfaces that.
- **Cost.** Bounded by the path filter, and deliberately out of `ci:local` for the reason
  `protocol-mutations` left it: a gate that makes every iteration wait gets removed, and then nothing runs.
- **The first CI run will fail for a missing `ANTHROPIC_API_KEY`.** That is the intended behaviour, not an
  oversight — a suite that reports green because it never ran is the state this change exists to end. The
  README says so and names the one setting that resolves it.

## Proof

- `pnpm agent-evals` green over all seven cases, output pasted in the commit.
- `pnpm agent-evals --drill ci-local-before-push` RED under neutralization, and the tree restored after —
  the evidence that the suite would fail without the configuration it claims to pin.
- `pnpm lint` + `pnpm intent-chain` green.
