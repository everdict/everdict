# Plan: to the ceiling

From: intent.md @ aa2dbb0b7ce1fcc170828f24e4e718b077ab714c

## Files that change

- `.claude/settings.json` — the deny half of the permission surface.
- `scripts/check-intent-chain.mjs` — a rejected intent needs a reason; a plan needs its spec's concerns settled.
- `scripts/scan/run.mjs` — `--dismiss`, writing a committed record.
- `scans/DISMISSED.md` (new) — the record.
- `docs/architecture/harness-declared-limits.md` — a second section for CHOSEN limits.
- `.claude/rules/ci.md`, `intent/README.md`.

## Order of work

1. The deny list, and prove it does not break the gates before believing it: `pnpm ci:local` reaches `curl`
   from inside a script rather than through the agent's tool surface, so the deny refuses the agent and not the
   gate. Verify by reading how the gate invokes it, not by running the whole gate.
2. `Status: rejected` requires a `Rejected:` line with a reason. One line, and it closes the half of the
   Plan-stage gate that currently leaves nothing behind.
3. The concerns gate: when `spec.md` exists and `plan.md` exists, every bullet under "Areas of concern" must
   be marked `RESOLVED` or `CARRIED`. Carried is legitimate — the article carries open questions forward.
   The existing machine-written spec is marked by hand, which is the design pass's own last step.
4. `--dismiss <scope> --file <path> --reason <text>`, appending to `scans/DISMISSED.md`, and the scan output
   marking a dismissed finding rather than repeating it as new.
5. The chosen-limit section, with `plan mode`'s L4 in it and the rule that separates the two kinds.
6. Drill each: a rejected intent with no reason, a plan over an unmarked concern, a dismissal with no reason.

## Risks

- **The deny list could refuse something the harness itself needs.** Narrow: secrets reads and direct network
  fetches. `pnpm`, `git`, `docker` and the editors stay on the allow list untouched.
- **The concerns gate could make the design pass a liability** — run `pnpm design`, get concerns, be unable to
  plan until they are marked. That is the intended cost and the article's own sequence; what makes it bearable
  is that CARRIED is a legal answer.
- **A dismissal record could become a graveyard of "not a bug".** It requires a reason and the reason is
  committed, which is the only pressure that works on this.

## Proof

- The gate scripts still run with the deny list in place, verified by reading how `ci:local` invokes `curl`.
- `intent-chain` RED on a rejected intent with no reason; RED on a plan whose spec has an unmarked concern.
- `pnpm scan --dismiss` writes a committed line and refuses without a reason.
- `harness-declared-limits.md` separates blocked from chosen, and says why the distinction matters.
- All gates green.
