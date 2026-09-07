# Plan: the watcher and the triager

From: intent.md @ 3a8ee8e21ce38ebbbb1e9b77687d572ff0e082fe

## Files that change

- `scripts/bands/bands.yaml` (new) — the metrics, their windows, their tiers. Versioned, because a band
  changed in a terminal is an alarm nobody can reproduce.
- `scripts/bands/watch.mjs` (new) — `pnpm watch-bands`: read, compute, tier, act.
- `scripts/triage.mjs` (new) — `pnpm triage <gate>`: run it, read its header, report.
- `package.json`, `.claude/rules/ci.md`, `docs/architecture/harness-observability.md`.

## Order of work

1. The reader: parse `evals/history.jsonl` and `.git/everdict-gate-log.jsonl` into series. Nothing else can
   be right if the series are wrong, so this is proven against the real files before any statistics exist.
2. The statistics: rolling mean and standard deviation over the window, and the sample floor. **Under the
   floor it reports INSUFFICIENT and exits 0 without banding** — that is not a breach and must not read as one.
3. The tiers, from the config: 1σ logs, 2σ invokes a read-only diagnosis, 3σ writes an `intent.md` into
   `intent/` with the anomaly, its evidence, the proposed outcome and the open questions — the Stage 1 shape,
   so the queue does not need to know it came from a machine.
4. `pnpm triage`: run the named gate, capture its output, read the header of its script, and ask a read-only
   session which rung fired and which of the repairs that header names applies. Report; never apply.
5. Prove: a synthetic series that breaches, one that does not, and one below the floor.

## Risks

- **A band over three points is noise wearing a sigma**, and the first thing it would do is file an intent
  nobody trusts. The floor is the whole defence, and it fails loud rather than quiet.
- **An intent.md written by a machine could flood the queue.** One per metric per breach, and the watcher
  refuses to write a second for a metric that already has an open one.
- **The 3σ tier could grow a route to the code.** It writes a file into `intent/` and nothing else; the
  `intent-chain` gate then applies to it exactly as it does to a human's.
- Triage that quotes a header nobody updated is confidently wrong. It reports the header's own words and says
  where it read them, so a stale header is visible as a stale header.

## Proof

- The reader parses the real ledgers and prints the series.
- A synthetic breaching series produces an `intent.md` in the Stage 1 shape that `pnpm intent-chain` accepts.
- A series under the floor reports INSUFFICIENT and writes nothing.
- `pnpm triage guardrails` over a deliberately broken gate names the rung and the repairs.
- `pnpm lint`, `docs-check`, `intent-chain`, `guardrails`, `scanner-watches` green.
