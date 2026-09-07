# Plan: evidence about the harness itself

From: intent.md @ a8abbff4e09560c2b88f1ccfe26152413d5331e1

## Files that change

- `scripts/hooks/gate-decision.mjs` (new) — the push decision as a pure function over facts.
- `scripts/hooks/pre-push-gate.mjs` — gathers the facts, calls it, writes the decision. No behaviour change.
- `scripts/check-guardrails.mjs` (new) — the wiring assertions plus the decision truth table.
- `evals/run.mjs` — append one line per run to `evals/history.jsonl`.
- `package.json`, `.github/workflows/ci.yml`, `scripts/ci-local.mjs` — wire `pnpm guardrails`.
- `.claude/rules/ci.md`, `.claude/skills/ci/SKILL.md`, `evals/README.md`.

## Order of work

1. Extract `decideGate({ head, pushed, ciLedger, evalLedger, configChanged })`. `ciLedger`/`evalLedger` are
   nullable **on purpose**: null means "could not be read", which is a deny with its own reason, not an empty
   ledger. Re-prove the four payload cases through the real hook afterwards — the refactor must not move them.
2. `check-guardrails.mjs`: (a) `.claude/settings.json` parses and its PreToolUse block still names
   `pre-push-gate.mjs`; (b) that file exists and consumes `decideGate`; (c) the truth table — unreadable CI
   ledger, unstamped tip, unstamped intermediate commit, config change without an eval stamp, config change
   with one, no config change. Each row asserts allow/deny AND that the reason names the right ledger.
3. Wire it into the three places a gate is declared, in the order `ci.yml` declares them.
4. `evals/history.jsonl`: append `{at, model, partial, cases:[{id,pass,seconds}], cost}`. A `--only` run
   records `partial: true` so a future band can filter it out rather than average it in.
5. Prove the removal drill: delete the hook block from `.claude/settings.json`, `pnpm guardrails` goes red
   for that reason, restore.

## Risks

- **A check that only reads text certifies spelling.** Step 2's truth table is the part that measures
  behaviour; the textual assertions only catch a wiring deletion, which is the other half.
- **The refactor could move behaviour while the check is being written against it.** Step 1 re-runs the four
  payload cases proven in the previous change before step 2 exists, so the baseline is the old behaviour and
  not the new code's opinion of it.
- **History could grow unbounded.** One JSON line per full run, a handful per week. If that ever matters it is
  a problem worth having.

## Proof

- The four hook payloads behave identically after the refactor.
- `pnpm guardrails` green; with the PreToolUse block deleted it is RED naming the missing wiring; restored.
- `pnpm agent-evals --only <id>` appends a line with `partial: true`.
- `pnpm lint` + `pnpm intent-chain` green.
