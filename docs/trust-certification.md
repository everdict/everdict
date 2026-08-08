# Trust certification (the nightly invariant suite)

Everdict's product is a **verdict**. Every other kind of bug costs a user time; a bug in the verdict costs
them the thing they came for, and does it silently — a number that looks like every other number, a green
light that looks like every other green light. The trust suite exists for exactly that class.

It certifies **invariants**, not features. Each scenario states a sentence that must never stop being true,
and all of them are variations on one:

> **No failure becomes a normal number or a normal verdict.**

A dead grader is not a zero. A batch that ran 4 of 5 cases is not a batch that passed. A policy nobody can
restore is not today's policy. A replica that stopped answering is not a replica that died. An exhausted
budget is not a budget.

- **Where it runs**: `.github/workflows/trust-nightly.yml` — nightly at 03:00 UTC, plus `workflow_dispatch`.
  It is deliberately **not** part of the push gate (`ci.yml`); see [Why it is not in ci.yml](#why-it-is-not-in-ciyml).
- **What runs it**: `scripts/trust/trust-suite.mjs`.
- **What it runs**: every `*.trust.test.ts` file in the repo, colocated with its subject.

## The one rule that makes the certification worth anything

**A skipped scenario is a FAILED certification.**

Every trust file skips itself when its infrastructure is absent — correct for a developer running one
scenario on a laptop, and catastrophic as a nightly default, because "0 failures out of 0 executed" would
print PASS. So `trust-suite.mjs` parses vitest's JSON report, counts what actually executed, and refuses to
certify if anything was skipped or if the scenario set is empty. It also refuses to start without a database
rather than running the non-Pg scenarios and reporting green.

A suite that certifies nothing must never look like a suite that certified everything. That is the same
failure mode the suite exists to catch, so the runner is held to it too.

## The scenarios

| ID | Invariant | Where |
| --- | --- | --- |
| TRUST-01 | A grader that dies produces an **unmeasured** score with no `value` field — the batch mean stays the mean of what was measured | `packages/job-runner/src/grader-failure.trust.test.ts` |
| TRUST-02 | A candidate that ran fewer cases than the baseline is **`blocked_missing`**, never a pass | `apps/api/src/trust/release-gate.trust.test.ts` |
| TRUST-03 | A stamped verdict policy that cannot be restored (or that disagrees with the baseline's) is **`not_comparable`**, and there is nothing to override | `apps/api/src/trust/release-gate.trust.test.ts` |
| TRUST-04 | A grader that returns `NaN` produces an **invalid** score, aggregated nowhere | `packages/job-runner/src/grader-failure.trust.test.ts` |
| TRUST-07 | A workspace quota is **fleet-wide AND race-proof**: two scheduler replicas hand it out once — including when both burst in the same instant against a stale snapshot (the atomic admission permit, mig 0139) | `apps/api/src/trust/fleet-admission.trust.test.ts` |
| TRUST-08 | Exactly one leader per role; a clean shutdown hands the lease back at once, a crash is replaced only when the lease expires | `apps/api/src/trust/leader-election.trust.test.ts` |
| TRUST-09 | Boot recovery reclaims a **dead** replica's batch and leaves a live one's alone; an unreadable heartbeat set reclaims nothing | `apps/api/src/trust/replica-recovery.trust.test.ts` |
| TRUST-10 | Caused work draws from its delegator's envelope — an exhausted cap refuses (402), runaway depth refuses (429), a forged causer refuses (400) | `apps/api/src/trust/envelope-budget.trust.test.ts` |
| TRUST-11 | A verifier checkpoint filed by the actor that executed the run is refused; a "fact" citing evidence that does not exist is refused | `apps/api/src/trust/self-verification.trust.test.ts` |

Plus the pre-existing live scenario test the nightly can now satisfy:

| | | |
| --- | --- | --- |
| workspace filesystem | recursive remove and move against a real S3 API (the MinIO batch-delete interop break) | `packages/storage/src/s3-fs.scenario.test.ts` |

### Why these are not "just unit tests again"

Most of these invariants already have unit tests, and those unit tests are good. The trust suite earns its
place by removing the fake:

- **Concurrency and clocks.** Leader election is one atomic upsert whose `WHERE` clause compares against the
  *database's* `now()`. A fake `SqlClient` can assert the SQL text; only Postgres can refuse the second
  claimant. Same for replica liveness, which is a `heartbeat_at > now() - staleMs` predicate.
- **Predicates.** Fleet admission is one `SELECT … WHERE status = 'running' AND …`. A hand-written ledger
  counting a `Map` agrees with *any* predicate, including a wrong one.
- **Serialization.** The gate's refusals stand on a stamp and a manifest that live in `jsonb` columns. A
  column that silently drops one turns `not_comparable` into a pass while every unit test stays green.

That last one is not hypothetical. **Writing TRUST-09 found a live defect**: `PgScorecardStore.list()`
selected an explicit column list that omitted `owner_replica`, and boot recovery reads batches through
`list()`. Every record therefore read as unowned, so a booting replica tombstoned batches another replica was
actively driving — reporting healthy in-flight work as `INTERRUPTED`. The unit tests were green throughout,
because the in-memory store hands back whole records.

## Running it locally

You need a Postgres the suite may migrate and write to. **Do not point it at a database you care about** —
the scenarios create and delete rows, and `migrate()` runs on connect.

```bash
# 1. a throwaway database (the local dev stack's Postgres is fine; give the suite its own database)
createdb -h 127.0.0.1 -p 5435 -U everdict everdict_trust

# 2. the whole suite, with the certification line at the end
EVERDICT_TRUST_DATABASE_URL=postgresql://everdict:PASSWORD@127.0.0.1:5435/everdict_trust \
  node scripts/trust/trust-suite.mjs
```

One scenario at a time, while working on it:

```bash
EVERDICT_TRUST_SUITE=1 \
EVERDICT_TRUST_DATABASE_URL=postgresql://everdict:PASSWORD@127.0.0.1:5435/everdict_trust \
  pnpm --filter @everdict/api exec vitest run src/trust/leader-election.trust.test.ts
```

The env vars are deliberately two:

- `EVERDICT_TRUST_SUITE=1` — run the trust suite at all. Without it every trust file skips, which is what
  keeps `pnpm test` (and therefore the push gate) fast.
- `EVERDICT_TRUST_DATABASE_URL` — the database the Pg-backed scenarios drive. Falls back to `DATABASE_URL`.

The MinIO scenario needs the workspace-filesystem endpoint instead:

```bash
EVERDICT_E2E_S3_ENDPOINT=http://127.0.0.1:9102 \
EVERDICT_E2E_S3_ACCESS_KEY=… EVERDICT_E2E_S3_SECRET_KEY=… \
  pnpm --filter @everdict/storage exec vitest run src/s3-fs.scenario.test.ts
```

## Adding a scenario

1. Write `<subject>.trust.test.ts` **next to its subject** — the same colocation the `.scenario.test.ts`
   files use. Files needing a database go under `apps/api/src/trust/`, which is where the shared gate lives
   (`trust-context.ts`: `TRUST_PG_ENABLED`, `openTrustPg`, `trustId`).
2. Gate the `describe` on `TRUST_PG_ENABLED` (or plain `EVERDICT_TRUST_SUITE === "1"` when no database is
   needed). Never gate individual `it`s — a half-run scenario is the thing this suite refuses to report.
3. Lead the file with the **invariant in one sentence**, then say **why a fake cannot prove it**. If you
   cannot answer the second question, the test belongs in the unit suite, where it will run on every push
   instead of once a night.
4. Nothing to register: the runner globs for the files and attributes each to its package.

## Deliberately excluded

- **Anything needing a paid model endpoint.** `packages/graders/src/model-judge.scenario.test.ts` calls a
  real LLM. This repository's Actions hold no such secret, and a nightly that silently no-ops when a key is
  missing is exactly the false green the suite exists to prevent. An operator running their own fork can
  enable it by adding `EVERDICT_E2E_OPENAI_BASE_URL` / `_KEY` / `_MODEL` as repository secrets and a step
  that runs `pnpm --filter @everdict/graders exec vitest run src/model-judge.scenario.test.ts`. It is
  intentionally not wired to `secrets.*` here, so nobody mistakes an unset secret for a passing judge.
- **macOS.** `cli-release.yml` and `desktop-release.yml` already build and test on `macos-latest` every
  release. Windows had no coverage anywhere, which is why the OS lane starts there.

## The Windows lane

Self-hosted runners run on operators' Windows machines, and until this workflow nothing in CI had executed a
line of that code on Windows. The nightly runs the packages whose tests are platform-independent **by
construction**:

| Package | Why it is in scope |
| --- | --- |
| `@everdict/contracts` | pure schemas and types; every path assertion is over a string, never the filesystem |
| `@everdict/domain` | pure business logic, no I/O by design |
| `@everdict/self-hosted-runner` | the OS-sensitive one — `capabilities.ts` branches on `process.platform` explicitly, and its test asserts the `win32` branch |

**Excluded, with the reason** — these are the expansion path, not an oversight. None of them are marked
passing:

| Package | Why it is excluded |
| --- | --- |
| `@everdict/drivers` | `local.test.ts` provisions a real `LocalDriver` and spawns a POSIX shell |
| `@everdict/job-runner` | `run-case.test.ts` runs the full loop over `LocalDriver` with `sh check.sh` |
| `@everdict/harnesses` | tests drive fake `ComputeHandle`s (so they look portable) but assert POSIX-shaped absolute paths like `/tmp/t.json`; unverified on Windows |

Expanding the lane means running the excluded package on `windows-latest`, reading what actually fails, and
fixing either the test's POSIX assumption or the code's. Adding a package to the filter without doing that
would turn a red lane green by not looking, which is the same move the trust suite exists to refuse.

## Why it is not in ci.yml

`ci.yml` is the **push gate**, and its value is that it is fast enough that nobody is tempted to work around
it. Booting Postgres and MinIO on every push, and running a Windows matrix that takes several times an ubuntu
job's minutes, would trade that away. The two workflows answer different questions:

| | `ci.yml` (every push) | `trust-nightly.yml` (nightly) |
| --- | --- | --- |
| asks | did this change break the code? | do the guarantees still hold? |
| runs against | fakes, in-memory stores | real Postgres, real MinIO |
| blocks | yes — a red `main` blocks everyone | no — it reports |

`scripts/ci-local.mjs` mirrors `ci.yml` step for step and is **not** extended to cover this workflow: a
scheduled job is not part of the push gate, and putting it there would mean booting a database before every
push.

## Tier B — the process-level scenarios (roadmap)

Everything above runs **in process**: real stores, real database, real SQL, but one Node process. The
scenarios below need a real process boundary — kill a running control plane and observe what the next one
does. They are the suite's next stage, and they are listed here rather than half-implemented because a
process-kill scenario that quietly degrades into an in-process one certifies nothing.

- **Kill the API mid-batch, boot a replacement, assert ownership is honored.** TRUST-09 certifies the
  *decision* (`recoverInterrupted` given a heartbeat set). The remaining claim is that a real booting process
  wires that decision correctly — which needs the composition root, not the use case.
- **Temporal worker kill and replay.** `scripts/live/orchestration-torture.mjs` and
  `scripts/live/chaos-orchestration.mjs` already drive real Temporal failure injection by hand. Wiring them
  in needs a Temporal service in the workflow; until then they stay manual.
- **A grader that hangs rather than throws.** Timeout handling under a real clock, not a fake one.
- **Cancel racing completion, and a duplicate case result.** Both are settlement races. They are honest Tier
  A candidates, but proving a *race* rather than a *sequence* needs two processes contending, which is the
  same infrastructure the first item needs.
- **The agent loop's own refusals.** TRUST-10 certifies the envelope at the CONTROL PLANE — the admission
  gate every lane that takes compute must pass. Two loop-level claims are not yet certified anywhere in this
  suite: that an out-of-scope capability is refused mid-turn while the run continues, and that a benign-named
  capability declaring external, non-idempotent effects still prompts in auto mode. Both need the agent
  runtime driven against a faked transport, which is a different harness from everything above; they belong
  in `apps/agent/src/trust/` when that harness exists. Until then they are covered by unit tests only, which
  is a weaker claim than the rest of this page makes.
