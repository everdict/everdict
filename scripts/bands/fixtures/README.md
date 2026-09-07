# Fixture series for the watcher's own refusal

Two gate-log series over the same thirty-sample history (twenty-eight allows, two denies): `breach/` ends
in a deny, which lands at roughly 3.7σ above the rolling mean and must make `watch-bands --dry-run` exit
non-zero; `quiet/` ends in an allow and must not. `pnpm guardrails` drives both, because the gate reads the
bands dry-run and a dry-run that exits 0 on a breach is a rehearsal the push never waits for.

Synthetic on purpose and never read by a real run: `--source-dir` is the only way in.
