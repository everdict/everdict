# Plan: the decision ledger and the telemetry sink

From: intent.md @ 10d211d5807fc5f74de4179200553d43f82fbcc3

## Files that change

- `scripts/hooks/pre-push-gate.mjs` — append one line per decision, after the push segment is identified.
- `scripts/telemetry/otlp-sink.mjs` (new) — dependency-free OTLP/HTTP receiver writing JSON lines.
- `scripts/telemetry/README.md` (new) — the environment recipe, and what is dropped when nothing listens.
- `package.json` — `pnpm telemetry`.
- `scripts/check-guardrails.mjs` — assert the hook still records, since a silent regression here is exactly
  the failure this change exists to end.
- `.claude/rules/ci.md`, `.claude/skills/ci/SKILL.md`, `docs/architecture/harness-observability.md` (new,
  indexed in `docs/README.md`).

## Order of work

1. The ledger write, wrapped so a failure cannot change the decision or wedge the session. One JSON line:
   `{at, verdict, head, arm, reason}`. `arm` names WHICH refusal fired, because "denied" without the arm is
   the same shape of record this change is replacing.
2. Extend `pnpm guardrails` to assert the hook writes it — the check that proves the recording exists must
   not itself be prose.
3. The OTLP sink: an HTTP server accepting `/v1/{traces,metrics,logs}`, appending the decoded JSON body to
   `.git/everdict-telemetry.jsonl`, and refusing to start on a port already in use rather than silently
   binding nothing.
4. The recipe: exact variable names, taken from the vendor documentation and not from memory, with the two
   that matter for this repository's own indicators called out — `claude_code.tool_decision` (the allow/block
   events) and session-id-bearing metrics (concurrent sessions).
5. A document under `docs/` recording what the harness can and cannot see about itself, indexed.

## Risks

- **A hook that logs on every Bash call produces a shell transcript, not an audit trail**, and would grow
  without bound. The write goes after the early exits, so only push decisions are recorded.
- **A sink nobody runs looks identical to a sink that works.** The recipe says exports are dropped when it is
  not listening; the sink refuses a busy port rather than appearing to start.
- **The ledger could become the thing that breaks pushes.** Wrapped, and the decision is computed before the
  write is attempted.

## Proof

- A denied push and an allowed push each append a line naming the arm; the file is JSON-parseable.
- `pnpm guardrails` red when the recording call is removed from the hook, green when restored.
- The sink starts, accepts a hand-made OTLP JSON post, appends it, and refuses a second start on the same port.
- `pnpm lint`, `pnpm docs-check`, `pnpm intent-chain` green.
