# Scan scopes, and why they are cut this way

`pnpm scan` reads a scope whole. The cut is by **dependency cone**, not by size, because a defect class lives
in a layer: authorship defects cluster where producer documents arrive, unreachable-refusal defects cluster
where conditional writes are, and reading half a layer answers half a question.

| scope | what it holds |
|---|---|
| `contracts` | the dependency root — schemas, errors, the pure total kernel functions |
| `domain` | the business kernel: aggregates, version algebra, scoring semantics, the authz matrix |
| `application` | the use-cases and the ports the adapters bind |
| `adapters` | db · registry · storage · auth — where the outside world is spoken to |
| `execution` | backends · drivers · job-runner · orchestrator — where work is dispatched |
| `agent-runtime` | the agent kernel |
| `api` | the control-plane HTTP surface, where every producer document arrives |
| `agent` | the reference owner runtime |

Not covered, deliberately: `apps/web` (its own lint and build, and its defect classes are different),
`apps/desktop`, `apps/cli`, `packages/sdk` and `packages/otel` (dependency-free surfaces), and everything
under `scripts/` — the gates read each other, and a scan of the scanners is a different question worth asking
separately.

## Rotation

`pnpm scan --next` takes the least-recently-scanned scope, and an unscanned one always wins. That is the whole
scheduling mechanism: running the scan needs no decision about where, which is what stops it becoming a thing
that only happens when somebody remembers.

`pnpm scan --status` answers "when did anyone last read this", per scope, with the model it was read under. A
scope that has never been scanned says NEVER rather than nothing — **unscanned is not clean**, and the whole
value of the ledger is that those two stop looking alike.
