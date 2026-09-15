# Plan: give the four plays their triggers

From: intent.md @ 9d3afe4192b1bf6be0ea3f6626a037af6a42c7dd

## Files that change

- `.claude/settings.json` — the telemetry env block.
- `scripts/design/run.mjs` (new) — `pnpm design`: the requirements-and-design pass, with `--next`.
- `scripts/check-intent-chain.mjs` — report an accepted intent with no spec.
- `scripts/ci-local.mjs` — read the bands every full run; triage the first red bespoke gate.
- `package.json`, `.claude/rules/ci.md`, `intent/README.md`.

## Order of work

1. Telemetry, because it is one file and already measured: the full recipe minus conversation content, pointed
   at the local sink. Verified silent with nothing listening before it goes in, not after.
2. `pnpm design`: read an accepted intent, run one non-interactive session with the repository's skills
   available, write `spec.md` beside it. `--next` takes the oldest accepted intent without one, so running it
   needs no decision about which. Writes into the working tree and commits nothing.
3. `intent-chain` reports those intents as a NOTE, never a violation.
4. `ci-local` runs `watch-bands --dry-run` — file reads and arithmetic, no model, no cost on a green run.
5. `ci-local` triages the first failing BESPOKE gate. Not lint or typecheck: those explain themselves, and a
   model call to restate a compiler error is the shape that teaches people to ignore the tool.

## Risks

- **Telemetry on by default could surprise.** It is local-only, conversation content excluded, and the recipe
  is documented where it was already documented. The measurement that made this safe is recorded rather than
  claimed.
- **A design pass that produces a bad spec is worse than none**, because a plan may then be written against
  it. It writes to the working tree and commits nothing, so the spec meets a person before it meets a plan.
- **Auto-triage on every red run costs a call every time a gate is red**, which during a bad afternoon is
  several. Bounded to the FIRST bespoke failure per run, and a full gate run is already minutes long.

## Proof

- A session started with the settings block exports to a running sink and is silent with none.
- `pnpm design --next` picks an intent, writes a spec beside it, and commits nothing.
- `pnpm intent-chain` notes the specless accepted intents and stays green.
- A deliberately reddened bespoke gate makes `ci:local` print a triage; lint does not.
- All twenty-seven gates green.
