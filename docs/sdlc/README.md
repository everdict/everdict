---
kind: wiki
title: "SDLC — how this repository is built, gated, and remembered"
status: current
updated: 2026-09-15
---
# SDLC — how this repository is built, gated, and remembered

The product is the agent-evaluation runtime under `apps/` and `packages/`. This directory is about something
else: the machinery that steers the agents and people who change that product, refuses what they get wrong,
and keeps the reasons. Until 2026-09-15 its records were spread across six root directories; they live here
now, and `docs/architecture/repository-layout.md` records that move and what it cost.

## Three layers, by where they live

    .claude/          what steers the agent while it works — rules pushed by glob, skills pulled by name,
                      agents, the hooks in settings.json
    scripts/          what refuses — every gate, the push hook, and the tools that run on demand
    docs/sdlc/        what is remembered — the requests, the incidents, the authorizations, and why each
                      gate exists (this directory)

`CLAUDE.md` at the root is the entry point for all three, and `REVIEW.md` is the policy `pnpm review` applies.

## Pages

- [gates.md](gates.md) — **the gate catalog**: every control, what it refuses, and the incident behind it.
  Read it before changing a gate; rule `ci` is the short form pushed while you edit.
- [declared-limits.md](declared-limits.md) — the harness clauses this deployment cannot satisfy and the one it
  declines, what their absence does NOT mean, and what reopens each (C1–C5).
- [observability.md](observability.md) — what the harness can see about itself: the ledgers in `.git/`, the
  eval history, and the session facts only telemetry answers.
- [drill-certificates.md](drill-certificates.md) — what was tried against the controls and what happened: dated
  removal, reconstruction and containment certificates, expiring at ninety days.

## Records

A record is a file whose shape another gate owns, so `pnpm docs-check` holds it only to resolving links (see
`RECORDS` in `scripts/check-docs.mjs`). Each directory's README is an ordinary document.

- [intent/README.md](intent/README.md) — where a change starts: `intent.md` → `spec.md` → `plan.md`, one
  directory per change, ordered by commit. Owned by `pnpm intent-chain`; `pnpm design` writes specs and
  `pnpm watch-bands` files intents for a 3σ breach.
- [lessons/README.md](lessons/README.md) — what an incident taught, in the four sentences no diff records.
  Owned by `pnpm lesson-evals`.
- [releases/README.md](releases/README.md) — the authorization a release tag needs before it may leave.
  Owned by the release arm of `scripts/hooks/pre-push-gate.mjs`.
- [finding-dispositions.md](finding-dispositions.md) — what happened to each finding the reviewer and the
  scanner reported (`pnpm findings`).
- [scan-dismissals.md](scan-dismissals.md) — which scan findings were dismissed, and why (`pnpm scan --dismiss`).

⚠️ **Two ledgers match by the path they cite.** An entry in `finding-dispositions.md` is joined to a report in
`.git/` by `source@key:file`, so an entry is never rewritten when the file it names moves — it names the file
as it was when it was graded.

## Tools that live in `scripts/`, not here

- `scripts/evals/` — `pnpm agent-evals`, the regression suite over the configuration that steers the agent;
  its `README.md` has the removal drill and the calibration history.
- `scripts/bands/` — `pnpm watch-bands`, the control bands over the eval history and the gate log.
- `scripts/scan/` — `pnpm scan`, the reader of code nobody touched, by dependency-cone scope.
- `scripts/review/`, `scripts/design/` — `pnpm review` and `pnpm design`.
- `scripts/telemetry/` — the OTLP sink a session starts, and `pnpm telemetry-report`.
- `scripts/hooks/` — the push gate and its pure decision.
