# Plan: close and declare

From: intent.md @ 78c483f32b2b4850caa81211c0df434029c25329

## Files that change

- `evals/cases/*.json` — seven more, from ⚠️ blocks in `.claude/rules/ci.md` and rule `protocol`.
- `scripts/check-lesson-evals.mjs` (new) — a lesson that SAYS it produced an eval case must have one.
- `scripts/design/run.mjs` — stamp the policy versions the spec was written under.
- `scripts/check-intent-chain.mjs` — a spec must carry that stamp.
- `docs/architecture/harness-declared-limits.md` (new, indexed) — one entry per unsatisfiable clause.
- `.claude/rules/ci.md`, `CLAUDE.md`, `package.json`, `ci.yml`, `scripts/ci-local.mjs`.
- the seven unscanned scopes (running while this is written).

## Order of work

1. The declared limits document FIRST. It is the part a reader needs most and the part most likely to be
   skipped if the code lands first and the session ends.
2. `pnpm lesson-evals`: parse each `lessons/*.md`'s "What was done about it" section; when it names an eval
   case, that case must exist in `evals/cases/`. When it says nothing was mechanised, pass — recording that
   decision is the documented answer.
3. Spec provenance: `pnpm design` writes `Policies: <sha of .claude/ at HEAD>` beside the `From:` line, and
   `intent-chain` requires it. A spec that cannot say which policies it was written under cannot be told from
   one written before they changed.
4. Seven cases, each from a recorded incident, each drilled if it passes.
5. The concurrency ceiling, stated where a person reading about parallel work will find it.
6. Run the suite; retire rather than tune anything that fails its drill.

## Risks

- **A declared limit becomes a way to stop trying.** Each entry carries a reopening condition, and the
  document says plainly that a clause blocked by infrastructure is not a clause satisfied.
- **Seven cases at once repeats the calibration cost.** Two of the last eight were refused at load and one
  retired after the run; expect the same rate and budget for it rather than tuning assertions until green.
- **The spec stamp could become a checksum nobody reads.** It is a git sha of `.claude/` — cheap to write,
  and the value is entirely in a future reader being able to diff it against today's policies.

## Proof

- `pnpm scan --status` shows no scope NEVER.
- `pnpm lesson-evals` green, and RED when a lesson names a case that does not exist.
- `pnpm design` writes a policy stamp; `intent-chain` refuses a spec without one.
- The suite green at twenty cases, with anything that fails its drill retired and recorded.
- All gates green.
