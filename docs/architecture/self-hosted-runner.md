---
kind: wiki
title: "Self-hosted runner — run a workspace's harness/dataset on *your own* machine"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/runner/runner-hub.ts, apps/api/src/core/execution/self-hosted-backend.ts, apps/api/src/api/runner/runner-lease.mcp.ts, packages/self-hosted-runner/src/runner-loop.ts]
---
# Self-hosted runner — run a workspace's harness/dataset on *your own* machine

A workspace defines a harness and a dataset (shared, in the registry). A **member** wants to run *those exact
artifacts* on **their own machine** — against their own repo, browser or OS, on their own Claude/Codex login — by
changing **only the runtime**. The in-process `local` runtime ([runtimes.md](../runtimes.md)) cannot do that: it
runs on the control-plane host, as the wrong identity. Three properties of the cluster model stood in the way:

1. **`RuntimeSpec` is workspace-shared.** A personal laptop registered in the workspace `RuntimeRegistry` would let
   one member's job land on another member's machine.
2. **Dispatch is push-only.** A laptop behind NAT or a firewall cannot be pushed to.
3. **The trust and cost model assumes Everdict owns the sandbox.** On a user's own host, isolation is the user's
   concern and the user's login pays, not the workspace's keys or budget.

The unit of work was already location-agnostic: `runCaseJob(job: CaseJob)` (`packages/job-runner/src/run.ts`) runs a
whole case over `LocalDriver`, which uses the machine's existing login. The self-hosted runner lets the user's
machine **pull** that job and scopes the runtime **personally**. It is additive: the push backends (`nomad|k8s`) are
untouched, and without a runner nothing dispatches differently. The pools, workspace-owned runners and GitHub
Actions co-registration built on the same machinery are in
[self-hosted-runtime-and-runners.md](./self-hosted-runtime-and-runners.md); service harnesses on the runner in
[self-hosted-service-runner.md](./self-hosted-service-runner.md); image cases in
[portable-harness-runtime.md](./portable-harness-runtime.md); installing the binary in
[runner-distribution.md](./runner-distribution.md). The live proof is `scripts/live/self-hosted-runner.mjs`.

## The decisions

- **D1 — ownership is personal.** A runner is owned by `principal.subject`, not the workspace. Harnesses and datasets
  stay shared; only the runtime becomes personal. It lives on the personal surface next to API keys, with no role
  gate. (The pattern was mirrored from Connected accounts, since removed — see
  [workspace-scoped-integrations.md](./workspace-scoped-integrations.md).)
- **D2 — results flow back to the workspace, tagged.** A self-hosted run is a normal workspace run in
  `RunStore`/`ScorecardStore` carrying `CaseResult.provenance { ranOn: "self-hosted", runner, by }`, so compare and
  regression see it *and* see that it ran on an unmanaged host.
- **D3 — only the owner dispatches to their runner.** `RuntimeDispatcher` resolves `self:<runnerId>` against the
  submitter (`resolveSelfRunner(owner, runnerId)`); anyone else — including a workspace admin — gets 404. There is no
  admin override and no `shared` flag. The lease queue is keyed `(owner, runnerId)` with no workspace in the key, so
  one runner serves all of its owner's workspaces; each job keeps its own `tenant` for results and budget.
- **D4 — packaging.** `everdict runner` (`apps/cli`) and the desktop app (`apps/desktop`) both drive the lease loop in
  `@everdict/self-hosted-runner`, which calls `runCaseJob` from `@everdict/job-runner`.
- **D5 — transport is MCP.** The runner is an automated client on `/mcp` (Streamable HTTP); lease, result and
  heartbeat are MCP tools.

## Where the runner lives

A runner is a **personal device pairing** in `RunnerStore` (`@everdict/db`, migration `0025_create_runners`), keyed
by `(owner, runnerId)` with the workspace it was paired in recorded for the roster. Metadata: label, os,
capabilities, last-seen. The pairing token (`rnr_…`) is shown once and stored only as its SHA-256 hash.
`runnerAuthenticator` (`@everdict/auth`) maps a `rnr_` token to `Principal { via: "runner", runnerId }`, a
least-privilege principal. It is not in the workspace `RuntimeRegistry`.

It surfaces as a runtime choice anyway: the scorecard run form's runtime picker lists the caller's own runners, and
choosing one sets `placement.target = self:<runnerId>`.

Personal pairing from a browser goes through the desktop app's one-click connect
(`docs/architecture/desktop-app.md`); the account page's "Connected runners" is manage-only (list, live status,
revoke). `POST /runners` (with an API key) plus `everdict runner --pair <rnr_…>` is the headless path. Pairing and
management have BFF↔MCP parity: `pair_runner` / `list_runners` / `revoke_runner`.

## How a job reaches the runner — pull, owner-scoped lease queue

```
push:         control plane → Backend.dispatch(job) → Nomad/K8s runs the job-runner image → parse __EVERDICT_RESULT__
self-hosted:  everdict runner → MCP lease_job (long-poll) → runLeasedJob(job) locally → MCP submit_job_result
```

- **`SelfHostedBackend`** (`apps/api/src/core/execution/self-hosted-backend.ts`) does not push to a cluster:
  `dispatch` parks the job in `RunnerHub` (`packages/application-control/src/runner/runner-hub.ts`) under its key and
  awaits the result the runner posts back, then stamps the provenance. `capacity()` is `maxConcurrent`. An unleased
  job is rejected after `queueTimeoutMs` (default 5 minutes). Because it is a `Backend`, the `Scheduler`'s fairness,
  budget and capacity machinery applies unchanged.
- **The re-lease is one transition (arch-review 47 §5.1, store lane).** A requeued job claimed again is a NEW physical
  execution. On the store-backed hub the whole attempt mint rides the claim's own transaction
  (`RunnerJobStore.claimAttempt`, migration 0183): claim the row → supersede the attempt it currently names
  (`current_attempt_id` carries the predecessor across replicas) → insert the new attempt (`executing`, lease epoch
  stamped) → restamp the job's recording generation → write `current_attempt_id` back — all-or-nothing. A ledger
  fault refuses the lease (rollback; the job stays claimable) rather than handing out a lease whose attempt the
  ledger never saw; a refused RECORDING claim still inserts the attempt row (unisolated) and strips the job's
  generation — the fail-closed live-only lane. The in-memory hub keeps the sequential equivalent.
- **The dispatch's own attempt is a predecessor too (arch-review 51).** The job carries its name (`CaseJob.attemptId`,
  written by the lane that opened it), the park records it (`current_attempt_id` at INSERT), and the first re-lease
  therefore supersedes the attempt that was actually running when the runner went silent. A re-leased job is
  restamped with BOTH halves of its new coordinate — generation and attempt name — because one attempt's name beside
  another's generation addresses two different physical executions.
- **MCP runner tools** (`apps/api/src/api/runner/runner-lease.mcp.ts`; runner-token principals only):
  - `lease_job { wait_ms?, capabilities?, os?, version?, protocol?, status? }` — the runner is identified by its
    token, never by an argument. A long-poll returning the next job for that runner (or `{job: null}` after
    `wait_ms`), minting the **attempt token** `{jobId, leaseEpoch}` (epoch bumped per lease, durable in migration
    0174). `capabilities` refreshes the runner's advertised set; a runner whose `protocol` is behind the control
    plane's is refused a lease (`{job: null, updateRequired: true}`), because the token is mandatory on the result
    wire.
  - `submit_job_result { jobId, leaseEpoch, result }` — the result is validated as a `CaseResult` and refused
    (`accepted: false`) unless the token is the CURRENT lease, so a paused runner's late result cannot become the
    completion of its successor's execution. `fail_job { jobId, leaseEpoch, message }` carries the same fence.
  - `heartbeat_job { jobId?, leaseEpoch?, capabilities?, status? }` — extends the lease only for its current holder
    and carries back a `cancelled` flag; an expired lease (`leaseTtlMs`, default 2 minutes) is requeued, so a dead
    runner never black-holes a job.
  - Every report tool (`report_case_screen` / `report_case_log` / `report_case_trace` / `report_case_track`) and the
    fs rendezvous (`poll_case_fs_requests` / `answer_case_fs_request`) authorizes by the SAME token, and the control
    plane reads the run FROM the lease — a caller-supplied run id is never written to, the live view included
    (TRUST-173: the token protects the outcome, not just the evidence that explains it).

## Trust, budget, provenance (D2)

- **Isolation** — a runner is the user's own host, opted into, so hardened isolation is not asserted: the
  self-hosted path never routes through a `TrustZone`. The result is tagged as unmanaged so the workspace can weight
  it.
- **Budget** — the user's own login pays. A personal self-hosted run does not draw the workspace's token/usd budget
  and counts only against `runs`; the harness's reported `total_cost_usd` is recorded, not billed.
- **Provenance** — `SelfHostedBackend` stamps `provenance { ranOn: "self-hosted", runner, by: <owner>,
  attestation: "self_reported" }` on the control-plane side.

## Operating a runner

- **Long-poll.** `RunnerHub.leaseWait` parks the runner until the next enqueue or `wait_ms`; the CLI's `--wait-ms`
  defaults to 25 s. A lease touches `lastSeenAt`, which drives the online/offline dot on the roster.
- **Dispatch-time offline diagnostic.** `resolveSelfRunner` / `poolRunners` carry `online` (`isRunnerOnline` in
  `@everdict/domain`, `RUNNER_ONLINE_WINDOW_MS`). No runner paired (404) and no capable runner (400) are hard
  failures; a capable but OFFLINE runner is soft — the job still parks, and `DispatchOptions.onWaiting` names the
  offline runner, which the scorecard batch records as one `dispatch/info` step instead of a silent "queued".
- **Self-reported status.** The runner sends a short status ("idle", "running N job(s)", "no Docker daemon", the
  last failure) on every lease and heartbeat; the control plane overlays it on the roster read for two minutes and
  does not store it.
- **Live execution log.** While running a case the runner pushes lifecycle lines through `report_case_log`, keyed by
  the run the lease names. `LiveLogStore` (`apps/api/src/common/live-log-store.ts`, in memory) buffers them, and
  `RunService.logs()` prefers the pushed log over a backend tail, so `GET /runs/:id/logs` and the run page's live-log
  panel show it with no self-hosted-specific read path.
- **Case-level parallelism.** `--max-concurrent N` runs N lease workers (`runLeaseWorkers`,
  `packages/self-hosted-runner/src/runner-loop.ts`) over one MCP session. `RunnerHub.lease` is synchronous and
  atomic, so concurrent `lease_job` calls never hand out the same job; effective parallelism is
  `min(scorecard concurrency, workers)`. For service harnesses the shared `DockerTopologyRuntime` makes
  `ensureTopology` single-flight per `id@version`.
- **Cross-workspace.** One runner leases jobs from every workspace its owner belongs to; each result, budget line
  and notification records to the job's own tenant.

## Multi-replica / high availability

The default `RunnerHub` is **in-process**: jobs park in a per-replica queue, and the dispatch promise a runner
resolves lives in the replica that parked it. That is correct for a single control-plane process. With several API
replicas, a runner long-polling replica A cannot lease a job parked on replica B; the job idle-times-out as
`no_runner`, and the error names that cause.

**Store-backed hub (`EVERDICT_SELF_HOSTED_STORE_HUB=1`):** `StoreRunnerHub` over a shared `RunnerJobStore` (Pg
migration `0055_runner_jobs`, table `everdict_runner_jobs`), the same cross-replica shape as
`StoreCallbackRendezvous`: park / claim (`FOR UPDATE SKIP LOCKED`, so two replicas never double-claim) / complete
persist to Postgres, and the parking replica collects the result by polling the row. The idle timeout is enforced
off `activity_at`, kept fresh cross-replica by lease and heartbeat. Capability gating is stored at park and filtered
on claim. Callers hold `RunnerHubLike = RunnerHub | StoreRunnerHub` and `await` its methods. The composition
(`apps/api/src/composition/dispatch.ts`) selects it from the flag.

A multi-replica deployment MUST set the flag; the rest of its single-process assumptions are addressed in
`docs/architecture/multi-replica.md`, the deployment contract the flag belongs to. Without it, run self-hosted dispatch
on a single replica, or pin a runner's lease/heartbeat and its matching dispatch to one replica. Managed backends are
unaffected — they place through the orchestrator.

## See also

[runtimes.md](../runtimes.md) · [workspace-scoped-integrations.md](./workspace-scoped-integrations.md) ·
[execution-backends.md](../execution-backends.md) · [judge-placement-locality](./judge-placement-locality.md) ·
skills `backends`, `api-layer`, `self-hosted-runner`.
