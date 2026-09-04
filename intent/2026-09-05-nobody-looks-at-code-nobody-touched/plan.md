# Plan: the scan that is not change-scoped, and a home for what an incident taught

From: intent.md @ 1911b59291e1cc63d4ac1a327d8d6582a831bd60

## Files that change

- `scripts/scan/run.mjs` (new) — `pnpm scan`: a scope, read whole, findings with confidence, recorded.
- `scripts/scan/SCOPES.md` (new) — what the scopes are and why they are cut that way.
- `lessons/README.md` + `lessons/TEMPLATE.md` (new).
- `package.json`, `scripts/bands/bands.yaml`, `.claude/rules/ci.md`, `docs/`.

## Order of work

1. The scope list and the ledger shape, before anything runs: a scan is a statement about a scope AT A TIME
   UNDER A MODEL, and if the record omits any of the three a clean scope is indistinguishable from an
   unscanned one.
2. `--status`: every scope with its last scan, its model and its age. This is the half that answers "when
   did anyone last read this", and it must work before the scanning half exists so the first answer is an
   honest "never".
3. `--next`: pick the least-recently-scanned scope, so running the scan needs no decision about where.
4. The scan itself: read-only, in a throwaway worktree, findings with `confidence` and `file`, written to
   `.git/everdict-scan-<scope>.json` and appended to `.git/everdict-scan-log.jsonl`.
5. A band over findings-per-scan, floor high enough to be honest about how few scans exist.
6. `lessons/` — the template asks what was BELIEVED at the time and what made it invisible, because the fix
   is already in the commit and neither of those is.

## Risks

- **A scan that reports the same finding every run is noise with a timestamp.** Findings carry the file and a
  one-line claim, so a person can compare two runs; deduplication across runs is deliberately not attempted
  until there are two runs to compare.
- **Cost.** One session per scope. Rotation means one scope at a time rather than the tree.
- **A confidence a model assigns to itself is not evidence.** It is recorded as what it is — the scanner's own
  rating — and the record says so rather than implying calibration nobody measured.
- **`lessons/` becoming a graveyard.** The template is four questions; anything longer will not be written.

## Proof

- `pnpm scan --status` over an empty ledger says every scope is unscanned, and does not imply they are clean.
- `pnpm scan --next` picks a scope and says why it picked it.
- A real scan of one scope produces findings with confidences and appends one ledger line.
- `pnpm watch-bands` reports INSUFFICIENT for the new metric rather than banding on one point.
- `pnpm lint`, `docs-check`, `intent-chain`, `scanner-watches`, `guardrails` green.
